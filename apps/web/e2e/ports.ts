// 默认连续用六个端口；端口被其他进程或 Windows 动态端口占用时，设 NEXTSKIN_E2E_PORT 换一组。
const value = process.env.NEXTSKIN_E2E_PORT ?? '3100'
export const port = Number(value)
if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65530) {
  throw new Error('NEXTSKIN_E2E_PORT 必须是 1–65530 的整数，给六个服务留出连续端口')
}

export const accountPort = port + 1
export const setupNewPort = port + 2
export const setupImportPort = port + 3
export const pluginsPort = port + 4
export const pluginsHostPort = port + 5
