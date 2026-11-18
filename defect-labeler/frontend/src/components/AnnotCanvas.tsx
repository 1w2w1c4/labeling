import type Konva from 'konva';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Group, Image as KImage, Label, Layer, Line, Rect, Stage, Tag, Text, Transformer } from 'react-konva';
import type { BBox, Defect, DefectClass } from '../api/types';

interface Props {
  url: string;
  width: number; // 原圖像素
  height: number;
  defects: Defect[];
  classes: DefectClass[];
  selected: string | null;
  drawClass: DefectClass | undefined;
  editable: boolean;
  showBoxes: boolean;
  onSelect: (id: string | null) => void;
  onCreate: (bbox: BBox) => void;
  /** 拖曳／調整大小：begin 記錄復原點、live 即時更新、end 結束 */
  onEdit: (phase: 'begin' | 'live' | 'end', id: string, bbox?: BBox) => void;
  onCursor: (pt: { x: number; y: number } | null) => void;
}

interface View {
  s: number;
  ox: number;
  oy: number;
}

const MIN_DRAW = 2; // 畫框最小 2×2 px（太小視為誤點）

function useImage(url: string) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = new window.Image();
    el.decoding = 'async';
    el.onload = () => setImg(el);
    el.onerror = () => setFailed(true);
    el.src = url;
    return () => {
      el.onload = null;
      el.onerror = null;
    };
  }, [url]);
  return { img, failed };
}

/** 圖片固定符合畫布（不縮放、不平移），在圖上拖曳畫框，拖框移動、拖控制點調整大小。 */
export function AnnotCanvas(p: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const { img, failed } = useImage(p.url);
  const trRef = useRef<Konva.Transformer>(null);
  const rectRefs = useRef(new Map<string, Konva.Rect>());
  const [hover, setHover] = useState<string | null>(null);
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const W = p.width;
  const H = p.height;

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const view: View = useMemo(() => {
    const s = size.w && size.h ? Math.min(size.w / W, size.h / H) * 0.94 : 1;
    return { s, ox: (size.w - W * s) / 2, oy: (size.h - H * s) / 2 };
  }, [size, W, H]);
  const { s, ox, oy } = view;

  const toImg = (x: number, y: number) => ({ x: (x - ox) / s, y: (y - oy) / s });
  const clampPt = (pt: { x: number; y: number }) => ({
    x: Math.round(Math.max(0, Math.min(W, pt.x))),
    y: Math.round(Math.max(0, Math.min(H, pt.y))),
  });
  const fromCorners = (c: { x1: number; y1: number; x2: number; y2: number }): BBox => ({
    x: Math.min(c.x1, c.x2),
    y: Math.min(c.y1, c.y2),
    w: Math.abs(c.x2 - c.x1),
    h: Math.abs(c.y2 - c.y1),
  });

  // Transformer 掛在選取的框上
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const node = p.selected && p.editable && p.showBoxes ? rectRefs.current.get(p.selected) : undefined;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [p.selected, p.editable, p.showBoxes, p.defects, view]);

  // 小框畫在上面，重疊時比較容易點到
  const order = useMemo(
    () => [...p.defects].sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h),
    [p.defects],
  );
  const indexOf = useMemo(() => new Map(p.defects.map((d, i) => [d.id, i])), [p.defects]);

  /** 從 Konva 節點目前的位置與縮放換算回原圖像素座標（整數、裁切在圖內） */
  const nodeToBBox = (node: Konva.Rect): BBox => {
    const w = Math.max(1, Math.min(W, Math.round((node.width() * node.scaleX()) / s)));
    const h = Math.max(1, Math.min(H, Math.round((node.height() * node.scaleY()) / s)));
    const x = Math.max(0, Math.min(W - w, Math.round((node.x() - ox) / s)));
    const y = Math.max(0, Math.min(H - h, Math.round((node.y() - oy) / s)));
    return { x, y, w, h };
  };
  const placeNode = (node: Konva.Rect, b: BBox) => {
    node.scale({ x: 1, y: 1 });
    node.position({ x: ox + b.x * s, y: oy + b.y * s });
    node.size({ width: b.w * s, height: b.h * s });
  };

  const onStageDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0) return;
    if (e.target.findAncestor('Transformer')) return;
    p.onSelect(null);
    if (!p.editable || !p.drawClass) return;
    const pos = e.target.getStage()!.getPointerPosition()!;
    const c = clampPt(toImg(pos.x, pos.y));
    setDraft({ x1: c.x, y1: c.y, x2: c.x, y2: c.y });
  };
  const onStageMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const pos = e.target.getStage()!.getPointerPosition();
    if (!pos) return;
    setMouse(pos);
    const ip = toImg(pos.x, pos.y);
    p.onCursor(ip.x >= 0 && ip.y >= 0 && ip.x <= W && ip.y <= H ? { x: Math.floor(ip.x), y: Math.floor(ip.y) } : null);
    if (draft) {
      const c = clampPt(ip);
      setDraft({ ...draft, x2: c.x, y2: c.y });
    }
  };
  const onStageUp = () => {
    if (!draft) return;
    const b = fromCorners(draft);
    setDraft(null);
    if (b.w >= MIN_DRAW && b.h >= MIN_DRAW) p.onCreate(b);
  };

  // Esc 取消畫到一半的框
  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDraft(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft]);

  const sel = p.defects.find((d) => d.id === p.selected);
  const liveTag = draft ? fromCorners(draft) : dragging && sel ? sel.bbox : null;
  const showCross = p.editable && mouse && (draft || (!hover && !dragging));

  return (
    <div
      ref={wrap}
      className="stage-wrap"
      style={{ cursor: !p.editable ? 'default' : hover ? 'move' : 'crosshair' }}
      onMouseLeave={() => {
        setMouse(null);
        setHover(null);
        p.onCursor(null);
      }}
    >
      {failed && <div className="img-failed">圖片載入失敗：{p.url}</div>}
      {size.w > 0 && (
        <Stage
          width={size.w}
          height={size.h}
          onMouseDown={onStageDown}
          onMouseMove={onStageMove}
          onMouseUp={onStageUp}
        >
          <Layer imageSmoothingEnabled={false}>
            {img && <KImage image={img} x={ox} y={oy} width={W * s} height={H * s} />}
            <Rect
              x={ox - 0.5}
              y={oy - 0.5}
              width={W * s + 1}
              height={H * s + 1}
              stroke="rgba(255,255,255,.15)"
              strokeWidth={1}
              listening={false}
            />

            {p.showBoxes &&
              order.map((d) => {
                const c = p.classes[d.class_id];
                const color = c?.color ?? '#ffffff';
                const isSel = d.id === p.selected;
                const isHov = d.id === hover;
                return (
                  <Rect
                    key={d.id}
                    ref={(n) => {
                      if (n) rectRefs.current.set(d.id, n);
                      else rectRefs.current.delete(d.id);
                    }}
                    x={ox + d.bbox.x * s}
                    y={oy + d.bbox.y * s}
                    width={d.bbox.w * s}
                    height={d.bbox.h * s}
                    stroke={color}
                    strokeWidth={isSel ? 3 : isHov ? 2.5 : 2}
                    fill={color + (isSel ? '30' : isHov ? '22' : '12')}
                    hitStrokeWidth={8}
                    draggable={p.editable}
                    onMouseEnter={() => setHover(d.id)}
                    onMouseLeave={() => setHover((h) => (h === d.id ? null : h))}
                    onMouseDown={(e) => {
                      e.cancelBubble = true;
                      p.onSelect(d.id);
                    }}
                    onDragStart={() => {
                      setDragging(true);
                      p.onSelect(d.id);
                      p.onEdit('begin', d.id);
                    }}
                    onDragMove={(e) => {
                      const node = e.target as Konva.Rect;
                      const b = nodeToBBox(node);
                      placeNode(node, b); // 對齊整數像素、限制在圖內
                      p.onEdit('live', d.id, b);
                    }}
                    onDragEnd={() => {
                      setDragging(false);
                      p.onEdit('end', d.id);
                    }}
                    onTransformStart={() => {
                      setDragging(true);
                      p.onEdit('begin', d.id);
                    }}
                    onTransform={(e) => {
                      const node = e.target as Konva.Rect;
                      const b = nodeToBBox(node);
                      placeNode(node, b);
                      p.onEdit('live', d.id, b);
                    }}
                    onTransformEnd={() => {
                      setDragging(false);
                      p.onEdit('end', d.id);
                    }}
                  />
                );
              })}

            {p.showBoxes &&
              p.defects.map((d) => {
                const c = p.classes[d.class_id];
                const ax = ox + d.bbox.x * s;
                const ay = oy + d.bbox.y * s;
                const ty = ay - 19 < oy ? ay : ay - 19;
                return (
                  <Label key={`l-${d.id}`} x={ax - 1} y={ty} listening={false}>
                    <Tag fill={c?.color ?? '#666'} />
                    <Text
                      text={`${(indexOf.get(d.id) ?? 0) + 1} ${c?.display ?? d.class_id}`}
                      fill="#fff"
                      fontSize={12}
                      fontStyle="600"
                      padding={4}
                      fontFamily='-apple-system, "PingFang TC", "Noto Sans TC", sans-serif'
                    />
                  </Label>
                );
              })}

            {draft && p.drawClass && (
              <Rect
                x={ox + fromCorners(draft).x * s}
                y={oy + fromCorners(draft).y * s}
                width={fromCorners(draft).w * s}
                height={fromCorners(draft).h * s}
                stroke={p.drawClass.color}
                strokeWidth={2}
                dash={[5, 4]}
                listening={false}
              />
            )}

            {showCross && mouse && (
              <Group listening={false}>
                <Line points={[0, mouse.y + 0.5, size.w, mouse.y + 0.5]} stroke="rgba(255,255,255,.45)" strokeWidth={1} dash={[4, 4]} />
                <Line points={[mouse.x + 0.5, 0, mouse.x + 0.5, size.h]} stroke="rgba(255,255,255,.45)" strokeWidth={1} dash={[4, 4]} />
              </Group>
            )}

            {liveTag && (
              <Label
                x={Math.min(ox + (liveTag.x + liveTag.w) * s + 6, size.w - 170)}
                y={Math.min(oy + (liveTag.y + liveTag.h) * s + 6, size.h - 22)}
                listening={false}
              >
                <Tag fill="rgba(0,0,0,.75)" />
                <Text
                  text={`x ${liveTag.x}, y ${liveTag.y}, w ${liveTag.w}, h ${liveTag.h}`}
                  fill="#fff"
                  fontSize={12}
                  padding={4}
                  fontFamily="ui-monospace, Menlo, monospace"
                />
              </Label>
            )}

            <Transformer
              ref={trRef}
              rotateEnabled={false}
              flipEnabled={false}
              keepRatio={false}
              ignoreStroke
              borderEnabled={false}
              anchorSize={8}
              anchorFill="#fff"
              anchorStroke={sel ? p.classes[sel.class_id]?.color ?? '#fff' : '#fff'}
              anchorStrokeWidth={2}
              boundBoxFunc={(oldBox, box) => {
                // 限制在圖片範圍內、至少 1 px
                const inside =
                  box.x >= ox - 0.5 &&
                  box.y >= oy - 0.5 &&
                  box.x + box.width <= ox + W * s + 0.5 &&
                  box.y + box.height <= oy + H * s + 0.5;
                return inside && box.width >= s && box.height >= s ? box : oldBox;
              }}
            />
          </Layer>
        </Stage>
      )}
    </div>
  );
}
