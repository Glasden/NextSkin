import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'
import { expect, test } from 'vitest'
import { getMessages, locales, sourceLocale } from './index.ts'

type Tree = { [key: string]: string | Tree }

/** 叶子消息，键用点号连起来 */
function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const result = new Map<string, string>()
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') result.set(path, value)
    else for (const [k, v] of flatten(value, path)) result.set(k, v)
  }
  return result
}

/** 消息里用到的参数名和类型，例如 hours:plural、nickname:argument */
function argumentsOf(elements: MessageFormatElement[], found = new Set<string>()): Set<string> {
  for (const element of elements) {
    if (element.type === TYPE.literal || element.type === TYPE.pound) continue
    found.add(`${element.value}:${TYPE[element.type]}`)
    if (element.type === TYPE.plural || element.type === TYPE.select) {
      for (const option of Object.values(element.options)) argumentsOf(option.value, found)
    }
    if (element.type === TYPE.tag) argumentsOf(element.children, found)
  }
  return found
}

const source = flatten(getMessages(sourceLocale))

for (const locale of locales) {
  const messages = flatten(getMessages(locale))

  test(`${locale}：和源语言的键完全相同`, () => {
    expect([...messages.keys()].sort()).toEqual([...source.keys()].sort())
  })

  test(`${locale}：每条消息都是合法的 ICU，参数和源语言相同`, () => {
    for (const [key, message] of messages) {
      const args = argumentsOf(parse(message))
      expect([...args].sort(), key).toEqual([...argumentsOf(parse(source.get(key)!))].sort())
    }
  })
}
