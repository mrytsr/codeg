// Which addresses belong to the remote codeg host a window is bound to.
//
// A remote-workspace window shows a workspace that lives on another machine,
// and the addresses its agents and terminals print — `localhost:3000`, a
// container's `172.17.0.2:8080` — are that machine's. The built-in browser is
// a webview of THIS computer, where the same address reaches this computer
// instead. Every place that opens a tab asks here first, so there is one
// answer for "is this address on the remote host?".

import { getServerBaseUrl, isRemoteDesktopMode } from "@/lib/transport"

import { hostnameOf, isRemoteHostName } from "./browser-url"

/** The remote codeg-server's own host name, in a remote-workspace window;
 *  null anywhere else. */
export function remoteServerHost(): string | null {
  return isRemoteDesktopMode() ? hostnameOf(getServerBaseUrl()) : null
}

/** Whether `url`, opened in this window, names a place on the remote codeg
 *  host rather than on this computer (see `isRemoteHostName`). Always false
 *  outside a remote-workspace window. */
export function isRemoteHostAddress(url: string): boolean {
  if (!isRemoteDesktopMode()) return false
  const hostname = hostnameOf(url)
  return hostname !== null && isRemoteHostName(hostname, remoteServerHost())
}
