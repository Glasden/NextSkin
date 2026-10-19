import { definePlugin } from '@nextskin/plugin-sdk'

export default definePlugin({
  capabilities: [],
  on: {
    'user.registered': async ({ event, ctx }) => {
      ctx.log.info('新用户注册', { uid: event.data.user.uid })
    },
  },
})
