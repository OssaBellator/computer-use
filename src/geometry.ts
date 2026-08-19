import type { Point, Rect } from './types.js';

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function rectContainsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/** Deterministic interior probes ordered from center toward corners. */
export function targetPointCandidates(
  elementRect: Rect,
  viewportRect: Rect,
  insetPx = 4,
): Point[] {
  const visible = intersectRect(elementRect, viewportRect);
  if (!visible || visible.width <= insetPx * 2 || visible.height <= insetPx * 2) return [];

  const left = visible.x + insetPx;
  const right = visible.x + visible.width - insetPx;
  const top = visible.y + insetPx;
  const bottom = visible.y + visible.height - insetPx;
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;

  return [
    { x: centerX, y: centerY },
    { x: left + (right - left) * 0.25, y: centerY },
    { x: left + (right - left) * 0.75, y: centerY },
    { x: centerX, y: top + (bottom - top) * 0.25 },
    { x: centerX, y: top + (bottom - top) * 0.75 },
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
  ];
}

export function chooseSafeTargetPoint(
  elementRect: Rect,
  viewportRect: Rect,
  occlusions: readonly Rect[] = [],
  insetPx = 4,
): Point | null {
  return (
    targetPointCandidates(elementRect, viewportRect, insetPx).find(
      (point) => !occlusions.some((occlusion) => rectContainsPoint(occlusion, point)),
    ) ?? null
  );
}

export function effectiveTargetWidth(rect: Rect, movement: Point): number {
  const length = Math.hypot(movement.x, movement.y);
  if (length === 0) return Math.max(1, Math.min(rect.width, rect.height));
  const ux = Math.abs(movement.x / length);
  const uy = Math.abs(movement.y / length);
  return Math.max(1, rect.width * ux + rect.height * uy);
}
