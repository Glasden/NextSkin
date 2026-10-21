import authmePassword from '@nextskin/plugin-authme-password/official'
import cdnRefresh from '@nextskin/plugin-cdn-refresh/official'
import invitationCodes from '@nextskin/plugin-invitation-codes/official'
import oauthGithub from '@nextskin/plugin-oauth-github/official'
import oauthGoogle from '@nextskin/plugin-oauth-google/official'
import oauthLittleskin from '@nextskin/plugin-oauth-littleskin/official'
import oauthMicrosoft from '@nextskin/plugin-oauth-microsoft/official'
import shareRegistrationLink from '@nextskin/plugin-share-registration-link/official'
import type { OfficialPlugin } from '@nextskin/domain'

/** 随发行包分发的官方插件，在核心进程内运行（ADR-0033）；装上不等于启用，启用在后台的插件页 */
export const officialPlugins: readonly OfficialPlugin[] = [
  invitationCodes,
  shareRegistrationLink,
  cdnRefresh,
  authmePassword,
  oauthGithub,
  oauthMicrosoft,
  oauthGoogle,
  oauthLittleskin,
]
