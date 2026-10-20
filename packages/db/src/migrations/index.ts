import type { Migration } from 'kysely/migration'
import * as createUsers from './0001_create_users.ts'
import * as createTextureFiles from './0002_create_texture_files.ts'
import * as createTextures from './0003_create_textures.ts'
import * as addUsersAvatarTextureId from './0004_add_users_avatar_texture_id.ts'
import * as createPlayers from './0005_create_players.ts'
import * as createSettings from './0006_create_settings.ts'
import * as createSessions from './0007_create_sessions.ts'
import * as createAccounts from './0008_create_accounts.ts'
import * as createVerifications from './0009_create_verifications.ts'
import * as createJwks from './0010_create_jwks.ts'
import * as createOauthClients from './0011_create_oauth_clients.ts'
import * as createOauthResources from './0012_create_oauth_resources.ts'
import * as createOauthClientResources from './0013_create_oauth_client_resources.ts'
import * as createOauthRefreshTokens from './0014_create_oauth_refresh_tokens.ts'
import * as createOauthAccessTokens from './0015_create_oauth_access_tokens.ts'
import * as createOauthConsents from './0016_create_oauth_consents.ts'
import * as createOauthClientAssertions from './0017_create_oauth_client_assertions.ts'
import * as createDeviceCodes from './0018_create_device_codes.ts'
import * as createTwoFactors from './0019_create_two_factors.ts'
import * as createPasskeys from './0020_create_passkeys.ts'
import * as createDeviceCodeSelections from './0021_create_device_code_selections.ts'

import * as createJobs from './0022_create_jobs.ts'
import * as createFailedJobs from './0023_create_failed_jobs.ts'
import * as createScoreTransactions from './0024_create_score_transactions.ts'

import * as addPlayersScorePaid from './0025_add_players_score_paid.ts'
import * as addUsersEmailVersion from './0026_add_users_email_version.ts'

import * as addTexturesScorePaid from './0027_add_textures_score_paid.ts'
import * as createClosetItems from './0028_create_closet_items.ts'
import * as createTexturesLibraryIndexes from './0029_create_textures_library_indexes.ts'

import * as createReports from './0030_create_reports.ts'

import * as createAuditLogs from './0031_create_audit_logs.ts'
import * as resolveOrphanedReports from './0032_resolve_orphaned_reports.ts'
import * as createJobSchedules from './0033_create_job_schedules.ts'

import * as createYggdrasilTokens from './0034_create_yggdrasil_tokens.ts'

import * as createImportRuns from './0035_create_import_runs.ts'
import * as createClosetItemsCreatedAtIndex from './0036_create_closet_items_created_at_index.ts'

import * as createPlugins from './0037_create_plugins.ts'
import * as createPluginKv from './0038_create_plugin_kv.ts'
import * as createPluginMigrations from './0039_create_plugin_migrations.ts'
import * as alterAccountsKeyColumns from './0040_alter_accounts_key_columns.ts'
import * as createAccountsBindingIndexes from './0041_create_accounts_binding_indexes.ts'
import * as insertSharedOauthClient from './0042_insert_shared_oauth_client.ts'
import * as createOauthReferenceIdIndexes from './0043_create_oauth_reference_id_indexes.ts'
import * as addUsersOauthVersion from './0044_add_users_oauth_version.ts'

export const coreMigrations: Record<string, Migration> = {
  '0001_create_users': createUsers,
  '0002_create_texture_files': createTextureFiles,
  '0003_create_textures': createTextures,
  '0004_add_users_avatar_texture_id': addUsersAvatarTextureId,
  '0005_create_players': createPlayers,
  '0006_create_settings': createSettings,
  '0007_create_sessions': createSessions,
  '0008_create_accounts': createAccounts,
  '0009_create_verifications': createVerifications,
  '0010_create_jwks': createJwks,
  '0011_create_oauth_clients': createOauthClients,
  '0012_create_oauth_resources': createOauthResources,
  '0013_create_oauth_client_resources': createOauthClientResources,
  '0014_create_oauth_refresh_tokens': createOauthRefreshTokens,
  '0015_create_oauth_access_tokens': createOauthAccessTokens,
  '0016_create_oauth_consents': createOauthConsents,
  '0017_create_oauth_client_assertions': createOauthClientAssertions,
  '0018_create_device_codes': createDeviceCodes,
  '0019_create_two_factors': createTwoFactors,
  '0020_create_passkeys': createPasskeys,
  '0021_create_device_code_selections': createDeviceCodeSelections,
  '0022_create_jobs': createJobs,
  '0023_create_failed_jobs': createFailedJobs,
  '0024_create_score_transactions': createScoreTransactions,
  '0025_add_players_score_paid': addPlayersScorePaid,
  '0026_add_users_email_version': addUsersEmailVersion,
  '0027_add_textures_score_paid': addTexturesScorePaid,
  '0028_create_closet_items': createClosetItems,
  '0029_create_textures_library_indexes': createTexturesLibraryIndexes,
  '0030_create_reports': createReports,
  '0031_create_audit_logs': createAuditLogs,
  '0032_resolve_orphaned_reports': resolveOrphanedReports,
  '0033_create_job_schedules': createJobSchedules,
  '0034_create_yggdrasil_tokens': createYggdrasilTokens,
  '0035_create_import_runs': createImportRuns,
  '0036_create_closet_items_created_at_index': createClosetItemsCreatedAtIndex,
  '0037_create_plugins': createPlugins,
  '0038_create_plugin_kv': createPluginKv,
  '0039_create_plugin_migrations': createPluginMigrations,
  '0040_alter_accounts_key_columns': alterAccountsKeyColumns,
  '0041_create_accounts_binding_indexes': createAccountsBindingIndexes,
  '0042_insert_shared_oauth_client': insertSharedOauthClient,
  '0043_create_oauth_reference_id_indexes': createOauthReferenceIdIndexes,
  '0044_add_users_oauth_version': addUsersOauthVersion,
}
