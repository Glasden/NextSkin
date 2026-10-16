'use client'
/**
 * 把宿主运行时的模块实例登记到 globalThis，供 import map 指向的 shim 导出。
 *
 * 这里 import 的 'react' 等模块，经过 Next 的别名，就是 App Router 实际使用的那一份（next/dist/compiled/react）。
 * 插件模块只会由 PluginSlot 动态加载，而 PluginSlot 静态导入了本文件，所以插件求值时登记一定已经完成。
 */
import * as React from 'react'
import * as ReactCompilerRuntime from 'react/compiler-runtime'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import * as PluginClient from '@nextskin/plugin-client'
import * as Ui from '@nextskin/ui'

export const SHARED_KEY = Symbol.for('nextskin.shared')

export const sharedModules = {
  react: React,
  'react/jsx-runtime': ReactJsxRuntime,
  'react/compiler-runtime': ReactCompilerRuntime,
  'react-dom': ReactDOM,
  '@nextskin/ui': Ui,
  '@nextskin/plugin-client': PluginClient,
} as const

export type SharedModuleName = keyof typeof sharedModules

if (typeof window !== 'undefined') {
  const g = globalThis as unknown as Record<symbol, unknown>
  g[SHARED_KEY] ??= Object.freeze({ ...sharedModules })
}
