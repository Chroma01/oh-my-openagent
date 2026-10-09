import { z } from "zod"

export class SignInError extends Error {
  override readonly name = "SignInError"
}

export const platformSchema = z.enum(["macos", "linux", "windows"])
export type Platform = z.infer<typeof platformSchema>
const nonempty = z.string().min(1)
const timestamp = z.string().datetime({ offset: true })
export const tokenSchema = z.object({
  accessToken: nonempty, accessTokenExpiresAt: timestamp, refreshToken: nonempty,
})
export const grantSchema = tokenSchema.extend({
  device: z.object({ id: nonempty, name: nonempty }),
  offlineGrant: nonempty.optional(),
})
export const credentialSchema = grantSchema.extend({
  signingPrivateKey: nonempty, sealingPrivateKey: nonempty,
})
export type Credentials = z.infer<typeof credentialSchema>
export const deviceCodeSchema = z.object({
  deviceCode: z.string().regex(/^dc\.[A-Za-z0-9_-]{43}$/),
  userCode: z.string().regex(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/),
  matchingCode: z.string().regex(/^\d{3} \d{3}$/),
  verificationUri: z.string().url(),
  expiresAt: timestamp,
  intervalSeconds: z.number().int().min(1).max(60),
})
const envelopeSchema = z.object({
  error: z.object({
    code: nonempty, message: z.string(), retryable: z.boolean(), requestId: z.string(),
    detail: z.unknown().optional(),
  }),
})
const limitSchema = z.object({
  reason: z.literal("device_limit"), managementToken: nonempty,
  used: z.number().int().nonnegative(), limit: z.number().int().nonnegative(),
})
export const deviceListSchema = z.object({
  devices: z.array(z.object({ id: nonempty, name: nonempty, revokedAt: timestamp.nullable() })),
})
export type ListedDevice = z.infer<typeof deviceListSchema>["devices"][number]
export type ChooseDevice = (devices: readonly ListedDevice[]) => Promise<string | null>

export class ApiRefusal extends SignInError {
  constructor(readonly code: string, readonly status: number, readonly detail?: z.infer<typeof limitSchema>) {
    // Server messages and unknown codes can contain credentials; never echo either.
    super("The service refused this request. Sign in again or check your account.")
  }
}

export function parseReply<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new SignInError("The service returned an invalid response.")
  return result.data
}

export function serviceOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new SignInError("Invalid service URL.") }
  const loopback = url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== ""
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new SignInError("Service URLs must be HTTPS origins, or http://127.0.0.1:<port> for local testing.")
  }
  return url.origin
}

export async function requestApi(api: string, path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  let response: Response
  let body: unknown
  try {
    response = await fetch(`${api}${path}`, {
      ...init, redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    })
    if (response.status === 204) return null
    body = await response.json()
  } catch {
    throw new SignInError("Unable to complete the service request. Check the connection and sign in again.")
  }
  if (response.ok) return body
  const envelope = envelopeSchema.safeParse(body)
  if (!envelope.success) throw new SignInError("The service returned an invalid error response.")
  const error = envelope.data.error
  const detail = limitSchema.safeParse(error.detail)
  throw new ApiRefusal(error.code, response.status,
    error.code === "entitlement_required" && detail.success ? detail.data : undefined)
}

export const jsonRequest = (body: unknown): RequestInit => ({
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
})
