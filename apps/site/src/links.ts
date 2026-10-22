// 首屏和尾页的入口（ADR-0055）。在用的站点不是演示站：直接链到它的皮肤库，不引导访客注册
export const links = {
  docs: 'https://docs.nextskin.org/',
  instance: 'https://skin.warma.fans/skinlib',
  github: 'https://github.com/Glasden/NextSkin',
} as const
