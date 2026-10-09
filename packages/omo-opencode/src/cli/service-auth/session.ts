import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { withLock } from "@oh-my-opencode/team-core/team-state-store/locks"
import { credentialId, type CredentialStore } from "./keystore"
import {
  ApiRefusal, type ChooseDevice, type Credentials, deviceListSchema, jsonRequest,
  parseReply, requestApi, RequestFailure, serviceOrigin, SignInError, tokenSchema,
} from "./protocol"

export function createSession(options: {
  readonly api: string
  readonly store: CredentialStore
  readonly home?: string
  readonly signal?: AbortSignal
}) {
  const api = serviceOrigin(options.api)
  const { store, signal } = options
  const directory = join(options.home ?? homedir(), ".omo", "session-locks")
  const lockPath = join(directory, `${credentialId(api)}.lock`)
  async function locked<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    signal?.throwIfAborted()
    return withLock(lockPath, async () => {
      signal?.throwIfAborted()
      return action()
    }, { ownerTag: "cli-session", staleAfterMs: Number.POSITIVE_INFINITY })
  }
  const request = (path: string, init: RequestInit) => requestApi(api, path, init, signal)
  const uncertain = () => new SignInError(
    "The refresh outcome is unknown. Saved credentials and keys were retained, but this refresh token will not be sent again. Retry sign-in with omo login.", true)
  return {
    request,
    signal,
    async ready() { await store.read() },
    async save(value: Credentials) { await locked(() => store.write(value)) },
    async logout(): Promise<boolean> {
      return locked(async () => {
        try {
          const current = await store.read()
          if (current !== null) await request(`/v1/devices/${encodeURIComponent(current.device.id)}`, {
            method: "DELETE", headers: { authorization: `Bearer ${current.accessToken}` },
          })
          return true
        } catch (error) {
          if (error instanceof SignInError) return false
          throw error
        } finally { await store.clear() }
      })
    },
    async accessToken(): Promise<string> {
      return locked(async () => {
        const current = await store.read()
        if (current === null) throw new SignInError("Not signed in. Run omo login.")
        if (current.refreshState === "uncertain") throw uncertain()
        if (Date.parse(current.accessTokenExpiresAt) > Date.now() + 30_000) return current.accessToken
        // Journal before sending: a lost response or process crash must never replay a single-use token.
        await store.write({ ...current, refreshState: "uncertain" })
        try {
          const tokens = parseReply(tokenSchema, await request("/v1/session/refresh", jsonRequest({ refreshToken: current.refreshToken })))
          await store.write({ ...current, ...tokens })
          return tokens.accessToken
        } catch (error) {
          if (error instanceof ApiRefusal && error.status < 500 && ["unauthorized", "account_deleted", "reauth_required", "invalid_grant"].includes(error.code)) {
            await store.clear()
            throw new SignInError(error.code === "reauth_required"
              ? "This session was ended because its refresh token was reused. Sign in again with omo login."
              : "Sign in again with omo login.")
          }
          if ((error instanceof RequestFailure && error.notSent) ||
            (error instanceof ApiRefusal && error.status === 429 && error.code === "rate_limited")) {
            await store.write(current)
            throw error
          }
          throw uncertain()
        }
      })
    },
    async removeForLimit(error: unknown, choose: ChooseDevice): Promise<boolean> {
      if (!(error instanceof ApiRefusal) || error.detail === undefined) throw error
      const headers = { authorization: `Bearer ${error.detail.managementToken}` }
      const listed = parseReply(deviceListSchema, await request("/v1/devices", { headers }))
      const devices = listed.devices.filter(device => device.revokedAt === null)
      const chosen = await choose(devices)
      if (chosen === null) return false
      if (!devices.some(device => device.id === chosen)) throw new SignInError("No matching device was selected.")
      await request(`/v1/devices/${encodeURIComponent(chosen)}`, { method: "DELETE", headers })
      return true
    },
  }
}
export type Session = ReturnType<typeof createSession>
