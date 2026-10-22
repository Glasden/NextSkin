import { contract } from './contract.tsx'
import { databases } from './databases.tsx'
import { deploy } from './deploy.tsx'
import { divider } from './divider.tsx'
import { doctor } from './doctor.tsx'
import { hero } from './hero.tsx'
import { hostSwap } from './host-swap.tsx'
import { importer } from './importer.tsx'
import { jobs } from './jobs.tsx'
import { kysely } from './kysely.tsx'
import { outro } from './outro.tsx'
import type { Page } from './page.ts'
import { pixelHashPage } from './pixel-hash.tsx'
import { pngGate } from './png-gate.tsx'
import { players } from './players.tsx'
import { protocols } from './protocols.tsx'
import { raster } from './raster.tsx'

/** 页的顺序（ADR-0055 的页表）：前半是服主和玩家看得见的部分，分界页以后讲底下的做法 */
export const pages: readonly Page[] = [
  hero,
  deploy,
  protocols,
  importer,
  databases,
  doctor,
  players,
  divider,
  pixelHashPage,
  pngGate,
  contract,
  raster,
  hostSwap,
  kysely,
  jobs,
  outro,
]
