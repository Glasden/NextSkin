export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { subscribePeerAddress } = await import('./lib/peer-address')
    subscribePeerAddress()
  }
}
