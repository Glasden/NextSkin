import { acquireDataLock } from '../lock.ts'

const lock = await acquireDataLock(process.argv[2]!)
process.send?.({ locked: Boolean(lock) })
setInterval(() => {}, 1000)
