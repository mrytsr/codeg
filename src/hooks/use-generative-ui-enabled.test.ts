import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({ getGenerativeUiSettings: vi.fn() }))
vi.mock("@/hooks/use-agent-skills", () => ({
  invalidateAgentSkillsCache: vi.fn(),
}))

// Capture the backend-broadcast handler the hook registers via `subscribe`, so
// tests can simulate a save made in the settings window.
let capturedEventHandler: ((s: { enabled: boolean }) => void) | null = null
let capturedReconnectHandler: (() => void) | null = null
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(
    async (_event: string, handler: (s: { enabled: boolean }) => void) => {
      capturedEventHandler = handler
      return () => {}
    }
  ),
  onTransportReconnect: vi.fn((handler: () => void) => {
    capturedReconnectHandler = handler
    return null
  }),
}))

// The hook caches at module scope; reset the module registry per test so each
// starts with a fresh (uncached) singleton.
beforeEach(() => {
  vi.resetModules()
  capturedEventHandler = null
  capturedReconnectHandler = null
})

async function setup(getImpl: () => Promise<{ enabled: boolean }>) {
  const api = await import("@/lib/api")
  vi.mocked(api.getGenerativeUiSettings).mockImplementation(async () => ({
    skill_conflict: false,
    unlink_failures: [],
    ...(await getImpl()),
  }))
  return import("./use-generative-ui-enabled")
}

describe("useGenerativeUiEnabled", () => {
  it("reflects the fetched value on mount", async () => {
    const { useGenerativeUiEnabled } = await setup(async () => ({
      enabled: true,
    }))
    const { result } = renderHook(() => useGenerativeUiEnabled())
    await waitFor(() => expect(result.current).toBe(true))
  })

  it("reacts to a save in this window without a remount", async () => {
    const { useGenerativeUiEnabled, primeGenerativeUiEnabled } = await setup(
      async () => ({ enabled: false })
    )
    const { result } = renderHook(() => useGenerativeUiEnabled())
    await waitFor(() => expect(result.current).toBe(false))

    act(() => primeGenerativeUiEnabled(true))
    expect(result.current).toBe(true)
  })

  it("converges to a save made in the settings window and drops cached skill lists", async () => {
    const { useGenerativeUiEnabled } = await setup(async () => ({
      enabled: false,
    }))
    const skills = await import("@/hooks/use-agent-skills")
    const { result } = renderHook(() => useGenerativeUiEnabled())
    await waitFor(() => expect(result.current).toBe(false))

    act(() => capturedEventHandler?.({ enabled: true }))
    expect(result.current).toBe(true)
    // The `json-render` skill comes and goes with the switch, so the `$`
    // menu's on-disk skill list has to be read again.
    expect(skills.invalidateAgentSkillsCache).toHaveBeenCalled()
  })

  it("a save during the in-flight initial load wins", async () => {
    let resolveFetch: (v: { enabled: boolean }) => void = () => {}
    const { useGenerativeUiEnabled, primeGenerativeUiEnabled } = await setup(
      () =>
        new Promise<{ enabled: boolean }>((r) => {
          resolveFetch = r
        })
    )
    const { result } = renderHook(() => useGenerativeUiEnabled())

    act(() => primeGenerativeUiEnabled(true))
    expect(result.current).toBe(true)

    await act(async () => {
      resolveFetch({ enabled: false })
      await Promise.resolve()
    })
    expect(result.current).toBe(true)
  })
  it("a broadcast during a reconnect re-fetch wins over what it read", async () => {
    let resolveRefetch: (v: { enabled: boolean }) => void = () => {}
    let calls = 0
    const { useGenerativeUiEnabled } = await setup(() => {
      calls += 1
      if (calls === 1) return Promise.resolve({ enabled: true })
      return new Promise<{ enabled: boolean }>((r) => {
        resolveRefetch = r
      })
    })
    const { result } = renderHook(() => useGenerativeUiEnabled())
    await waitFor(() => expect(result.current).toBe(true))

    // The WS comes back and the re-fetch reads the old value...
    act(() => capturedReconnectHandler?.())
    // ...while a switch-off made elsewhere arrives first.
    act(() => capturedEventHandler?.({ enabled: false }))
    expect(result.current).toBe(false)

    await act(async () => {
      resolveRefetch({ enabled: true })
      await Promise.resolve()
    })
    expect(result.current).toBe(false)
  })
  it("of two reconnect re-fetches, the later one's read stands", async () => {
    const pending: Array<(v: { enabled: boolean }) => void> = []
    let calls = 0
    const { useGenerativeUiEnabled } = await setup(() => {
      calls += 1
      if (calls === 1) return Promise.resolve({ enabled: false })
      return new Promise<{ enabled: boolean }>((r) => {
        pending.push(r)
      })
    })
    const { result } = renderHook(() => useGenerativeUiEnabled())
    await waitFor(() => expect(result.current).toBe(false))

    // Two reconnects in a row: the first read saw it off, the second (after
    // a broadcast this window missed) sees it on. The first answers last.
    act(() => capturedReconnectHandler?.())
    act(() => capturedReconnectHandler?.())
    await waitFor(() => expect(pending).toHaveLength(2))
    await act(async () => {
      pending[1]({ enabled: true })
      await Promise.resolve()
    })
    expect(result.current).toBe(true)
    await act(async () => {
      pending[0]({ enabled: false })
      await Promise.resolve()
    })
    expect(result.current).toBe(true)
  })

  it("a reconnect re-fetch that answers first does not void a later one", async () => {
    const pending: Array<(v: { enabled: boolean }) => void> = []
    let calls = 0
    const { useGenerativeUiEnabled } = await setup(() => {
      calls += 1
      if (calls === 1) return Promise.resolve({ enabled: false })
      return new Promise<{ enabled: boolean }>((r) => {
        pending.push(r)
      })
    })
    const { result } = renderHook(() => useGenerativeUiEnabled())
    await waitFor(() => expect(result.current).toBe(false))

    act(() => capturedReconnectHandler?.())
    act(() => capturedReconnectHandler?.())
    await waitFor(() => expect(pending).toHaveLength(2))
    await act(async () => {
      pending[0]({ enabled: false })
      await Promise.resolve()
    })
    await act(async () => {
      pending[1]({ enabled: true })
      await Promise.resolve()
    })
    expect(result.current).toBe(true)
  })
  it("a flag primed before any hook mounted still follows broadcasts", async () => {
    const { useGenerativeUiEnabled, primeGenerativeUiEnabled } = await setup(
      async () => ({
        enabled: true,
      })
    )
    // The settings page primes this window's flag; no hook has mounted yet.
    act(() => primeGenerativeUiEnabled(true))
    // A later save elsewhere turns it off.
    act(() => capturedEventHandler?.({ enabled: false }))

    // The first hook to mount takes the primed cache without loading, so
    // the cache itself must have followed the broadcast.
    const { result } = renderHook(() => useGenerativeUiEnabled())
    expect(result.current).toBe(false)
  })
})
