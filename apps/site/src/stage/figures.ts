// 场景里用到的出图（scripts/figures.ts 生成到 public/gen/pose）。density 是画面上一个标准像素占几个排版像素，
// 生成脚本按它出 1 倍和 2 倍两份。浏览器和生成脚本共用这个文件，不能引入别的模块

export interface PoseImageSpec {
  name: string
  view: 'front' | 'both'
  density: number
  /** 抬手拼图：5 帧从左到右排开 */
  raise?: boolean
}

export const poseImages = [
  { name: 'front-d8', view: 'front', density: 8 },
  { name: 'both-d4', view: 'both', density: 4 },
  { name: 'front-d4', view: 'front', density: 4 },
  { name: 'both-raise-d4', view: 'both', density: 4, raise: true },
] as const satisfies readonly PoseImageSpec[]

export type PoseImageName = (typeof poseImages)[number]['name']

/** 光栅化的过程分几步画完，每步一张图 */
export const RASTER_STEPS = 16
/** 光栅化过程的大图和深度缓冲的小图（出图页 raster 的四列流水线，一列 270 宽） */
export const RASTER_DENSITY = 8
export const DEPTH_DENSITY = 2
