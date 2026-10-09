const fakeStoreUrl = process.env.OMO_TEST_KEYSTORE_URL
if (!fakeStoreUrl?.startsWith("http://127.0.0.1:")) throw new Error("local fake keystore required")
const get = async () => {
  const response = await fetch(fakeStoreUrl, { proxy: "" })
  const value: unknown = await response.json()
  if (value !== null && typeof value !== "string") throw new Error("invalid fake keystore value")
  return value
}
const set = async ({ value }: { readonly value: string }) => {
  await fetch(fakeStoreUrl, { method: "PUT", body: value, proxy: "" })
}
const remove = async () => {
  await fetch(fakeStoreUrl, { method: "DELETE", proxy: "" })
  return true
}
Object.defineProperty(Bun, "secrets", { value: { get, set, delete: remove } })
