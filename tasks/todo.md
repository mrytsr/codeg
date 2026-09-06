# Model Provider Backend Tasks

## Phase 1

- [x] Add models.json Rust types and parser
- [x] Add ordered, atomic, locked file writer
- [x] Implement provider CRUD service and validation
- [x] Add Tauri commands and Axum routes
- [x] Mirror API types in TypeScript
- [x] Switch frontend `ModelProviderService` from mock to transport

## Phase 2

- [x] Add `agent_setting.model_source`
- [x] Return source from `AcpAgentInfo`
- [x] Implement `acp_update_agent_model_source`
- [x] Persist source-card UI state

## Phase 3

- [ ] Add conversation provider/model selection columns
- [ ] Implement selection validation and setter
- [ ] Thread selection into launch and config fingerprint

## Phase 4

- [ ] Add provider launch adapter trait
- [ ] Implement env-only agents
- [ ] Implement Codex config projection
- [ ] Implement Claude/Gemini native parity
- [ ] Implement remaining agent adapters

## Phase 5

- [ ] Implement four API model probes
- [ ] Implement per-model tests
- [ ] Implement proxy support
- [ ] Implement built-in clone templates
- [ ] Add models.json corruption, locking, and launch integration tests
