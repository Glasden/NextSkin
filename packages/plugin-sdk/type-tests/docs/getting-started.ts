import { definePlugin } from '@nextskin/plugin-sdk'

export default definePlugin({
  capabilities: [],
  on: {
    'user.registered': async ({ event, ctx }) => {
      ctx.log.info(ctx.t('log.registered'), { uid: event.data.user.uid })
    },
  },
})
