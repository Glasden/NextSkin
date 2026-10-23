/**
 * 密码强度：纯前端指示，不参与校验。密码的合法性只有长度边界（password-policy.ts），
 * 弱密码也能提交——强度只是帮用户意识到自己的密码弱。
 *
 * 判定顺序：先排除，再分档。
 * 1. 硬弱规则命中任一就直接算弱：长度不够、纯数字、常见弱口令、含个人信息、几乎全是连续/重复/键盘序列。
 * 2. 有结构（连续、重复、键盘序列）的密码进不了「强」和「极强」。
 * 3. 剩下的按长度、字符种类和多样性分档。
 *
 * 字符种类按书写系统分：拉丁小写、拉丁大写、数字、汉字、假名、谚文、希腊、西里尔、阿拉伯、
 * 希伯来、泰文、天城文、其他文字、emoji、符号。非 ASCII 的字符各算各的种类，不并进「小写」
 * 或「符号」——一串中文口令是一种，「汉字 + 假名」是两种，「汉字 + 英文 + 数字 + 符号」是四种。
 */

export type PasswordLevel = 0 | 1 | 2 | 3

export interface PasswordContext {
  /**
   * 和这个人有关的词：登录名、角色名、昵称、邮箱（只用 @ 前面那段，再按 . _ - + 拆开）。
   * 密码里包含任何一个（3 个字符以上）就算弱，这类信息在社工库里都是现成的
   */
  readonly usernames?: readonly (string | null | undefined)[]
}

/** 和 password-policy.ts 的下限一致：更短的密码服务端根本不收 */
const MIN_LENGTH = 8

/**
 * 常见弱口令，取自泄露口令榜和国内常见的套路密码。比较前会做规范化（小写、还原 leet 变形、去掉非字母），
 * 所以 password123!、P@ssw0rd、qwerty2024 这些变体同样会被拦住
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  'passwd',
  'pass',
  'pass123',
  'iloveyou',
  'letmein',
  'welcome',
  'welcome1',
  'admin',
  'admin123',
  'administrator',
  'root',
  'toor',
  'test',
  'test123',
  'guest',
  'secret',
  'default',
  'changeit',
  'monkey',
  'dragon',
  'master',
  'shadow',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'soccer',
  'hockey',
  'superman',
  'batman',
  'starwars',
  'trustno1',
  'whatever',
  'mustang',
  'access',
  'matrix',
  'michael',
  'jennifer',
  'charlie',
  'freedom',
  'computer',
  'internet',
  'samsung',
  'google',
  'facebook',
  'linkedin',
  'windows',
  'linux',
  'minecraft',
  'notch',
  'steve',
  'qwerty',
  'qwerty1',
  'qwerty12',
  'qwerty123',
  'qwertyuiop',
  'asdfgh',
  'asdfghjkl',
  'zxcvbn',
  'zxcvbnm',
  'qazwsx',
  'qweasd',
  'qwe123',
  'asd123',
  'zxc123',
  '1qaz',
  '2wsx',
  '3edc',
  '4rfv',
  '1q2w3e',
  '1q2w3e4r',
  'q1w2e3r4',
  'q1w2e3r4t5',
  '1qaz2wsx',
  'zaq12wsx',
  'qaz123',
  '123qwe',
  '123qweasd',
  'aa123456',
  'abc123',
  'abc123456',
  'abcd1234',
  'a123456',
  'a123456789',
  '123456a',
  '123456abc',
  '123456qq',
  'qq123456',
  'woaini',
  'woaini1314',
  'woaini520',
  '1314520',
  '5201314',
  '520520',
  'wang123',
  'wang123456',
  'li123456',
  'zhang123',
])

/** leet 变形还原，只用于和弱口令表、个人信息比对，不参与分档 */
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'l',
  '2': 'z',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '6': 'g',
  '7': 't',
  '8': 'b',
  '9': 'g',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'l',
  '+': 't',
}

/** 键盘上相邻的一行，正反两个方向都算（qwerty、ytrewq 都是套路） */
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'qazwsxedcrfv', '1qaz2wsx3edc']

export function passwordStrength(password: string, context: PasswordContext = {}): PasswordLevel | null {
  if (!password) return null
  const chars = [...password]
  const length = chars.length
  if (length < MIN_LENGTH) return 0

  // 硬弱规则：命中任一就是弱，不再往下看
  if (isAllDigits(chars)) return 0
  if (isCommonPassword(chars)) return 0
  if (containsPersonal(chars, context)) return 0
  const structure = structureOf(chars)
  if (structure === 'severe') return 0

  const classes = classCount(chars)
  const unique = uniqueRatio(chars)
  const varied = diversity(chars)
  const plain = structure === 'none'

  // 极强
  if (length >= 16 && classes === 4 && plain && varied >= 0.6) return 3
  if (length >= 14 && classes >= 3 && plain && varied >= 0.6) return 3
  if (length >= 20 && classes >= 3 && plain) return 3
  // 长而且没有结构的口令短语（correcthorsebatterystaple、几个中文词连起来）：NIST SP 800-63B 认可这种，
  // 只有一种字符也不该压到「一般」
  if (length >= 20 && plain && varied >= 0.6) return 3

  // 强
  if (length >= 12 && classes >= 3 && plain) return 2
  if (length >= 10 && classes === 4 && plain) return 2

  // 一般
  if (classes >= 2) return 1
  // 只有一种字符：够长、不太重复、也没有结构，才给「一般」（例如一串较长的中文口令）
  if (length >= 12 && plain && unique >= 0.5) return 1
  return 0
}

/** 小写、还原 leet 变形 */
function normalize(text: string): string {
  let result = ''
  for (const char of text.toLowerCase()) result += LEET[char] ?? char
  return result
}

/** 去掉所有非字母，用来发现「常见口令 + 数字/符号后缀」这种变体 */
function lettersOf(text: string): string {
  return text.replace(/[^\p{L}]/gu, '')
}

function isCommonPassword(chars: string[]): boolean {
  const lower = chars.join('').toLowerCase()
  for (const candidate of [lower, normalize(lower)]) {
    if (COMMON_PASSWORDS.has(candidate)) return true
    if (COMMON_PASSWORDS.has(lettersOf(candidate))) return true
  }
  return false
}

function isAllDigits(chars: string[]): boolean {
  return chars.every((char) => /\p{N}/u.test(char))
}

/** 密码里包含登录名、角色名、昵称或邮箱里的词 */
function containsPersonal(chars: string[], context: PasswordContext): boolean {
  const haystack = normalize(chars.join(''))
  for (const raw of context.usernames ?? []) {
    if (!raw) continue
    for (const token of tokensOf(raw)) {
      const needle = normalize(token)
      if (needle.length >= 3 && haystack.includes(needle)) return true
    }
  }
  return false
}

/** 邮箱只取 @ 前面那段，再按分隔符拆成词 */
function tokensOf(raw: string): string[] {
  const at = raw.indexOf('@')
  const local = at === -1 ? raw : raw.slice(0, at)
  return local.split(/[._+\s-]+/u).filter((token) => token.length > 0)
}

/**
 * 非 ASCII 的文字各算一类：汉字、假名、谚文、希腊、西里尔、阿拉伯、希伯来、泰文、天城文，
 * 没列到的文字统一算「其他文字」。这些文字没有值得单独分档的大小写差别，按文字分类就够了；
 * 拉丁字母的小写和大写则各算一类
 */
const SCRIPTS: readonly (readonly [string, RegExp])[] = [
  ['han', /\p{Script=Han}/u],
  ['kana', /\p{Script=Hiragana}|\p{Script=Katakana}/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['greek', /\p{Script=Greek}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['thai', /\p{Script=Thai}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
]

function classCount(chars: string[]): number {
  const classes = new Set<string>()
  for (const char of chars) classes.add(classOf(char))
  return classes.size
}

/** 一个字符属于哪种字符：拉丁小写、拉丁大写、数字、emoji、符号、各种文字 */
function classOf(char: string): string {
  if (/\p{Script=Latin}/u.test(char)) {
    if (/\p{Ll}/u.test(char)) return 'lower'
    if (/\p{Lu}/u.test(char)) return 'upper'
  }
  for (const [name, pattern] of SCRIPTS) if (pattern.test(char)) return name
  if (/\p{N}/u.test(char)) return 'digit'
  if (/\p{Extended_Pictographic}/u.test(char)) return 'emoji'
  if (/[\p{S}\p{P}]/u.test(char)) return 'symbol'
  if (/\p{L}/u.test(char)) return 'letter'
  // 组合符号、不换行空格这类既不是字母数字也不是标点的字符
  return 'other'
}

/** 不同字符数 / 长度，大小写不敏感（AaAaAaAa 只有 2 个不同字符） */
function uniqueRatio(chars: string[]): number {
  return new Set(chars.map((char) => char.toLowerCase())).size / chars.length
}

/** 三元组的去重比例：自然词组里字母会重复，但相邻三个字符的组合几乎不重复 */
function trigramRatio(chars: string[]): number {
  if (chars.length < 3) return 1
  const seen = new Set<string>()
  for (let index = 0; index + 2 < chars.length; index++)
    seen.add((chars[index] ?? '').concat(chars[index + 1] ?? '', chars[index + 2] ?? '').toLowerCase())
  return seen.size / (chars.length - 2)
}

/**
 * 多样性取唯一字符比例和三元组比例里大的那个：correcthorsebatterystaple 的唯一字符比例只有 0.48，
 * 但它不是重复结构，单看唯一比例会把正常的短语误判成重复
 */
function diversity(chars: string[]): number {
  return Math.max(uniqueRatio(chars), trigramRatio(chars))
}

/** 连续、重复、键盘序列覆盖了多少字符：占全长八成以上算严重（整串就是这个套路），其余算有结构 */
function structureOf(chars: string[]): 'none' | 'mild' | 'severe' {
  if (chars.length < 4) return 'none'
  const count = coveredPositions(chars).filter(Boolean).length
  if (count < 4) return 'none'
  return count / chars.length >= 0.8 ? 'severe' : 'mild'
}

function coveredPositions(chars: string[]): boolean[] {
  const covered = chars.map(() => false)
  const lower = chars.map((char) => char.toLowerCase())
  const mark = (from: number, length: number) => {
    for (let index = from; index < from + length && index < covered.length; index++) covered[index] = true
  }

  // 同一个字符连着 4 个以上（aaaa）
  for (let start = 0; start + 3 < lower.length; start++) {
    let end = start
    while (end + 1 < lower.length && lower[end + 1] === lower[start]) end++
    if (end - start + 1 >= 4) mark(start, end - start + 1)
    start = end
  }

  // 升序或降序连着 4 个以上（abcd、4321）
  for (let start = 0; start + 3 < lower.length; start++) {
    const step = codeOf(lower[start + 1]) - codeOf(lower[start])
    if (step !== 1 && step !== -1) continue
    let end = start + 1
    while (end + 1 < lower.length && codeOf(lower[end + 1]) - codeOf(lower[end]) === step) end++
    if (end - start + 1 >= 4) mark(start, end - start + 1)
    start = end
  }

  // 整串是一个短单元的重复（abcabcabc、aBcaBc）
  for (let period = 1; period <= 4; period++) {
    if (lower.length < period * 2 || lower.length % period !== 0) continue
    let repeated = true
    for (let index = period; index < lower.length && repeated; index++)
      if (lower[index] !== lower[index % period]) repeated = false
    if (repeated) mark(0, lower.length)
  }

  // 键盘上相邻的一段（qwerty、asdf、1qaz）
  for (const row of KEYBOARD_ROWS) {
    for (const direction of [row, [...row].reverse().join('')]) {
      const match = longestCommonRun(lower, [...direction])
      if (match.length >= 4) mark(match.end - match.length + 1, match.length)
    }
  }

  return covered
}

/** 两个字符数组最长的公共连续片段，返回长度和它在第一个数组里的结束下标 */
function longestCommonRun(chars: string[], pattern: string[]): { length: number; end: number } {
  let best = { length: 0, end: 0 }
  let previous = new Array<number>(pattern.length + 1).fill(0)
  for (let index = 0; index < chars.length; index++) {
    const current = new Array<number>(pattern.length + 1).fill(0)
    for (let column = 1; column <= pattern.length; column++) {
      if (chars[index] !== pattern[column - 1]) continue
      const length = (previous[column - 1] ?? 0) + 1
      current[column] = length
      if (length > best.length) best = { length, end: index }
    }
    previous = current
  }
  return best
}

/** 码点，用于判断是不是连续的字符序列 */
function codeOf(char: string | undefined): number {
  return char === undefined ? Number.NaN : (char.codePointAt(0) ?? Number.NaN)
}
