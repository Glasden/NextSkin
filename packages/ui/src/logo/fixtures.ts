// story 用的“站长上传的标志”：圆形徽章，四角透明，看得出棋盘格。只给 story 用，不从包里导出
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`,
  `<circle cx="32" cy="32" r="30" fill="#2f7d4f"/>`,
  `<path d="M32 10 52 32 32 54 12 32Z" fill="#7fd6a0"/>`,
  `<path d="M32 10 52 32H12Z" fill="#b8f0cc"/>`,
  `</svg>`,
].join('')

export const uploadedLogo = `data:image/svg+xml,${encodeURIComponent(svg)}`
