// Tipuri minimale pentru serviciile diagram-js folosite aici (bpmn-js le expune prin `get<T>(nume)`).

export interface ModdleObject {
  $type: string;
  id: string;
  name?: string;
  default?: ModdleObject;
  get(name: string): unknown;
  $instanceOf(type: string): boolean;
}
export interface DiagramElement {
  id: string;
  type: string;
  businessObject: ModdleObject;
  parent?: DiagramElement;
  source?: DiagramElement;
  target?: DiagramElement;
  waypoints?: unknown[];
  labelTarget?: DiagramElement;
}
export interface Canvas {
  zoom(): number;
  zoom(scale: number | 'fit-viewport', center?: 'auto' | { x: number; y: number }): number;
  scroll(delta: { dx: number; dy: number }): unknown;
  scrollToElement(element: DiagramElement | string, padding?: number): void;
  addMarker(element: DiagramElement | string, marker: string): void;
  resized(): void;
}
export interface ElementRegistry {
  get(id: string): DiagramElement | undefined;
  getAll(): DiagramElement[];
}
export interface Overlays {
  add(element: DiagramElement | string, type: string, overlay: {
    position: { top?: number; left?: number; right?: number; bottom?: number };
    html: HTMLElement | string;
    scale?: boolean | { min?: number; max?: number };
  }): string;
}
export interface Modeling {
  updateProperties(element: DiagramElement, properties: Record<string, unknown>): void;
}
export interface EventBus {
  on<E = unknown>(event: string, callback: (event: E) => unknown): void;
  off(event: string, callback: (...args: never[]) => unknown): void;
}
export interface CommandStack {
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}
export interface Selection {
  select(element: DiagramElement | DiagramElement[]): void;
}

export const isType = (element: DiagramElement | undefined, type: string): boolean =>
  !!element?.businessObject?.$instanceOf?.(type);
