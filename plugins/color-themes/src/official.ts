/** 随发行包分发、在核心进程内运行时交给核心的东西（ADR-0033"官方插件"） */
import pkg from '../package.json' with { type: 'json' }
import en from '../locales/en.json' with { type: 'json' }
import zhCN from '../locales/zh-CN.json' with { type: 'json' }
import definition from './index.ts'

export default { definition, package: pkg, messages: { 'zh-CN': zhCN, en } }
