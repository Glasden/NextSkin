import { expect, test } from 'vitest'
import { checkCustomCss, parseHeadCode, type HeadCodeError } from './head.ts'

const providers = [
  [
    'GA4',
    `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-TEST');
</script>`,
    2,
  ],
  [
    '百度统计',
    `<script>
var _hmt = _hmt || [];
(function() {
  var hm = document.createElement("script");
  hm.src = "https://hm.baidu.com/hm.js?test";
  var s = document.getElementsByTagName("script")[0];
  s.parentNode.insertBefore(hm, s);
})();
</script>`,
    1,
  ],
  ['Umami', '<script defer src="https://cloud.umami.is/script.js" data-website-id="test-id"></script>', 1],
  ['Plausible', '<script defer data-domain="example.com" src="https://plausible.io/js/script.js"></script>', 1],
  [
    '51.la',
    `<script charset="UTF-8" id="LA_COLLECT" src="//sdk.51.la/js-sdk-pro.min.js"></script>
<script>LA.init({id:"test",ck:"test"})</script>`,
    2,
  ],
  [
    'Cloudflare',
    `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"test"}'></script>`,
    1,
  ],
  [
    'AdSense',
    '<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-test" crossorigin="anonymous"></script>',
    1,
  ],
  [
    'GTM',
    `<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','GTM-TEST');</script>
<!-- End Google Tag Manager -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-TEST"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`,
    1,
  ],
  [
    '验证 meta',
    `<meta name="google-site-verification" content="google">
<meta name="baidu-site-verification" content="baidu">
<meta name="msvalidate.01" content="bing">`,
    3,
  ],
] as const

test.each(providers)('%s 原样代码及 head 包装可以解析，脚本原文保留', (_provider, source, count) => {
  const result = parseHeadCode(source)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.elements).toHaveLength(count)
  expect(parseHeadCode(`<head>${source}</head>`)).toEqual(result)
  for (const element of result.elements)
    if (element.kind === 'script') {
      if (element.attributes.src) expect(element.code).toBe('')
      else expect(source).toContain(`<script>${element.code}</script>`)
    }
})

test('脚本属性归一化，布尔属性忽略值，data-* 保留全名，nonce 丢掉', () => {
  expect(
    parseHeadCode(`<SCRIPT SRC=" HTTPS://example.test/a.js " ASYNC="false" defer="no"
type=" TEXT/JAVASCRIPT " crossorigin="anonymous" referrerpolicy="no-referrer"
integrity="sha256-test" charset="UTF-8" id="LA_COLLECT" nonce="old"
data-website-id="id" data-cf-beacon='{"token":"test"}' data-x.y_z-1="v"> \n</SCRIPT>`),
  ).toEqual({
    ok: true,
    elements: [
      {
        kind: 'script',
        attributes: {
          src: 'HTTPS://example.test/a.js',
          async: true,
          defer: true,
          type: 'text/javascript',
          crossorigin: 'anonymous',
          referrerpolicy: 'no-referrer',
          integrity: 'sha256-test',
          charset: 'UTF-8',
          id: 'LA_COLLECT',
          data: { 'data-website-id': 'id', 'data-cf-beacon': '{"token":"test"}', 'data-x.y_z-1': 'v' },
        },
        code: '',
      },
    ],
  })
  expect(parseHeadCode('<meta property="og:image" content="a&amp;b">')).toEqual({
    ok: true,
    elements: [{ kind: 'meta', property: 'og:image', content: 'a&b' }],
  })
})

test.each(['', 'text/javascript', 'module', 'application/json', 'application/ld+json'])(
  '允许的脚本类型 %s，内联代码不解码实体，换行统一成 \\n（同浏览器）',
  (type) => {
    expect(parseHeadCode(`<script type="${type}">\r\nconst x = "&amp;";\r\n</script>`)).toEqual({
      ok: true,
      elements: [{ kind: 'script', attributes: { type, data: {} }, code: '\nconst x = "&amp;";\n' }],
    })
  },
)

test.each<[string, Omit<HeadCodeError, 'line'>]>([
  ['var x = 1;', { reason: 'text' }],
  ...['style', 'link', 'div', 'iframe'].map((tag): [string, Omit<HeadCodeError, 'line'>] => [
    `<${tag}></${tag}>`,
    { reason: 'tag', tag },
  ]),
  ['<script onload="run()"></script>', { reason: 'event_handler', tag: 'script', attribute: 'onload' }],
  ['<script title="x"></script>', { reason: 'attribute', tag: 'script', attribute: 'title' }],
  ['<script data-="x"></script>', { reason: 'attribute', tag: 'script', attribute: 'data-' }],
  ['<script data-_x="x"></script>', { reason: 'attribute', tag: 'script', attribute: 'data-_x' }],
  ['<script src="javascript:run()"></script>', { reason: 'script_src', tag: 'script', attribute: 'src' }],
  ['<script src="/local.js"></script>', { reason: 'script_src', tag: 'script', attribute: 'src' }],
  ['<script src=""></script>', { reason: 'script_src', tag: 'script', attribute: 'src' }],
  ['<script src="//example.test/a.js">run()</script>', { reason: 'script_src_and_code', tag: 'script' }],
  // 渲染出来以后，浏览器会跳过脚本自己的结束标签，把后面的页面也当成脚本
  ['<script><!--<script>', { reason: 'script_code', tag: 'script' }],
  // React 按 src 去重 async 的外部脚本，第二个会被丢掉
  [
    '<script async src="https://example.test/a.js" data-id="1"></script><script async src=" https://example.test/a.js " data-id="2"></script>',
    { reason: 'script_duplicate', tag: 'script', attribute: 'src', value: 'https://example.test/a.js' },
  ],
  [
    '<script type=" ImportMap ">{}</script>',
    { reason: 'script_type', tag: 'script', attribute: 'type', value: ' ImportMap ' },
  ],
  ['<meta http-equiv="refresh" content="0">', { reason: 'attribute', tag: 'meta', attribute: 'http-equiv' }],
  ['<meta charset="UTF-8">', { reason: 'attribute', tag: 'meta', attribute: 'charset' }],
  ['<meta name="verify">', { reason: 'meta', tag: 'meta' }],
  ['<meta content="verify">', { reason: 'meta', tag: 'meta' }],
  ['<meta name="verify" property="verify" content="x">', { reason: 'meta', tag: 'meta' }],
  ...['viewport', 'description', 'keywords', 'og:type', 'og:site_name', 'og:title', 'og:description'].map(
    (value): [string, Omit<HeadCodeError, 'line'>] => [
      `<meta name="${value.toUpperCase()}" content="x">`,
      { reason: 'meta_reserved', tag: 'meta', attribute: 'name', value: value.toUpperCase() },
    ],
  ),
  [
    '<meta property="og:title" content="x">',
    { reason: 'meta_reserved', tag: 'meta', attribute: 'property', value: 'og:title' },
  ],
])('第三行的错误有具体原因、属性和行号：%s', (source, error) => {
  expect(parseHeadCode(`<!-- first -->\n  \n  ${source}\n<div></div>`)).toEqual({
    ok: false,
    error: { ...error, line: 3 },
  })
})

test('同一个 src 不带 async 时可以写两遍，React 不去重', () => {
  const result = parseHeadCode(
    '<script async src="https://example.test/a.js"></script>\n<script defer src="https://example.test/a.js"></script>',
  )
  expect(result.ok && result.elements).toHaveLength(2)
})

test('空白、注释和 noscript 不输出；第一处错误按文档顺序返回', () => {
  expect(parseHeadCode(' \n<!-- comment --><noscript><iframe onload="x"></iframe></noscript>')).toEqual({
    ok: true,
    elements: [],
  })
  expect(parseHeadCode('<script>ok()</script>\n\n  broken\n<link>')).toEqual({
    ok: false,
    error: { reason: 'text', line: 3 },
  })
})

test.each(['</style', '</STYLE>', 'body {}\n</StYlE >'])('CSS 拒绝结束标签：%s', (css) => {
  expect(checkCustomCss(css)).toBe(false)
})

test('CSS 允许普通样式、字符串及 @import', () => {
  expect(checkCustomCss('')).toBe(true)
  expect(checkCustomCss('@import url("https://example.test/font.css"); body { color: var(--color-primary); }')).toBe(
    true,
  )
})
