// www.nextskin.org 的 Worker（ADR-0055）：全部 301 到根域名，路径和查询参数原样带上，http 一并换成 https
export default {
  fetch(request: Request) {
    const url = new URL(request.url)
    url.protocol = 'https:'
    url.hostname = 'nextskin.org'
    url.port = ''
    return Response.redirect(url.toString(), 301)
  },
}
