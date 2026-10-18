import cdnRefresh from '@nextskin/plugin-cdn-refresh/official'
import invitationCodes from '@nextskin/plugin-invitation-codes/official'
import type { OfficialPlugin } from '@nextskin/domain'

/** 随发行包分发的官方插件，在核心进程内运行（ADR-0033）；装上不等于启用，启用在后台的插件页 */
export const officialPlugins: readonly OfficialPlugin[] = [invitationCodes, cdnRefresh]
