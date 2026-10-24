// 多屏跨屏迁移器。
//
// 职责分工：前端只做【本地】贴边检测（宠物位置 + 活动边界，零 IPC）；邻屏查找与窗口
// 迁移全部在 Rust 侧完成（`move_pet_window_to_edge_neighbor`）：
//   - macOS 用 AppKit 逻辑坐标（NSWindow frame + NSScreen 邻接判断 + setFrame 原子迁移），
//     不经 tao 物理坐标——tao 在缩放主屏（非整数 DPI）/混合 DPI 布局下换算失真，且
//     monitorFromPoint 对虚空探测点【永不返回】（旧实现在此挂死）。
//   - Windows/Linux 用 tao 物理坐标（该平台上正确），同一套邻接判断。
//
// 迁移后把宠物重定位到目标屏「进入侧的相反侧」内侧（inset > PADDING + 触发阈值），
// 防止立即反向弹跳。

import { invoke } from '@tauri-apps/api/core'

import type { PetController } from './PetController'

/** 前端诊断日志透传到应用日志（dev 排查跨屏迁移链路）。 */
function debugLog(message: string): void {
  void invoke('debug_log', { message: `[Migrator] ${message}` }).catch(() => {})
}

/** 迁移命令返回的窗口几何（新屏；width/height 为该平台坐标系的尺寸，logical* 为 CSS px）。 */
interface WindowGeometry {
  width: number
  height: number
  logicalWidth: number
  logicalHeight: number
}

/** 迁移器依赖：拿到宠物位置 + 迁移后重算视口。 */
export interface MigratorDeps {
  pet: PetController
  onMigrated: () => void
}

/** 宠物距活动边界小于该值（逻辑像素）时视为贴边。 */
const EDGE_TRIGGER_PX = 24
/** 迁移采样间隔（ms）。 */
const TICK_INTERVAL_MS = 120
/** 连续两次迁移最小间隔（ms），防抖。 */
const MIN_MIGRATE_GAP_MS = 600
/** 宠物足迹半宽 + 侧边距（与 viewport.ts 的 footprint(72)+SIDE(16) 一致）。 */
const PADDING = 88

/**
 * 创建跨屏迁移器。返回 tick()，由引擎 ticker 周期调用（内部按 TICK_INTERVAL_MS 节流）。
 */
export function createCrossMonitorMigrator(deps: MigratorDeps) {
  let lastTickAt = 0
  let lastMigrateAt = 0
  let migrating = false
  let lastNoNeighborLogAt = 0

  async function tick(): Promise<void> {
    if (migrating) return
    const now = Date.now()
    if (now - lastTickAt < TICK_INTERVAL_MS) return
    lastTickAt = now
    if (now - lastMigrateAt < MIN_MIGRATE_GAP_MS) return

    try {
      // 1. 宠物当前画布坐标 + 活动边界（clamp 后的实际可达范围）。
      //    贴边检测纯本地——绝大多数 tick 宠物在屏幕中部，到此返回，零 IPC。
      const pos = deps.pet.getSnapshotForMigration()
      const bounds = deps.pet.migrationBounds
      if (!pos || !bounds) return

      const atLeftEdge = pos.x <= bounds.minX + EDGE_TRIGGER_PX
      const atRightEdge = pos.x >= bounds.maxX - EDGE_TRIGGER_PX
      const atTopEdge = pos.y <= bounds.minY + EDGE_TRIGGER_PX
      const atBottomEdge = pos.y >= bounds.maxY - EDGE_TRIGGER_PX
      if (!atLeftEdge && !atRightEdge && !atTopEdge && !atBottomEdge) return

      // 2. 方向：水平优先（多数多屏为左右布局；对边同真不可能，邻角取水平）。
      const side = atLeftEdge ? 'left' : atRightEdge ? 'right' : atTopEdge ? 'top' : 'bottom'

      // 3. Rust 侧完成邻屏查找 + 窗口迁移；无邻屏（虚空边缘）返回 Err，属常态。
      migrating = true
      let geo: WindowGeometry
      try {
        geo = await invoke<WindowGeometry>('move_pet_window_to_edge_neighbor', { side })
      } catch (e) {
        const msg = String(e)
        if (now - lastNoNeighborLogAt > 1000) {
          lastNoNeighborLogAt = now
          debugLog(`no neighbor side=${side}: ${msg}`)
        }
        return
      } finally {
        migrating = false
      }
      lastMigrateAt = Date.now()
      debugLog(`migrated ${side} -> ${geo.logicalWidth}x${geo.logicalHeight}`)

      // 4. 重定位宠物到目标屏「进入侧的相反侧」内侧，防反向弹跳。
      //    inset 须 > PADDING + EDGE_TRIGGER_PX，使 clamp 后位置不再满足贴边条件。
      const w = geo.logicalWidth > 0 ? geo.logicalWidth : geo.width
      const h = geo.logicalHeight > 0 ? geo.logicalHeight : geo.height
      const inset = PADDING + EDGE_TRIGGER_PX + 60
      const clampX = (x: number) => Math.max(PADDING, Math.min(w - PADDING, x))
      const clampY = (y: number) => Math.max(PADDING, Math.min(h - PADDING, y))
      let newCanvasX: number
      let newCanvasY: number
      if (side === 'left') {
        // 当前屏左出 → 目标屏右内侧
        newCanvasX = clampX(w - inset)
        newCanvasY = clampY(pos.y)
      } else if (side === 'right') {
        newCanvasX = clampX(inset)
        newCanvasY = clampY(pos.y)
      } else if (side === 'top') {
        newCanvasX = clampX(pos.x)
        newCanvasY = clampY(h - inset)
      } else {
        newCanvasX = clampX(pos.x)
        newCanvasY = clampY(inset)
      }

      deps.pet.dragTo(newCanvasX, newCanvasY)
      deps.onMigrated()
    } catch (error) {
      migrating = false
      debugLog(`tick error: ${String(error)}`)
      console.warn('[CrossMonitorMigrator] migrate failed:', error)
    }
  }

  return { tick }
}
