// Paleta și meniul contextual oferă doar elementele acceptate de motorul de fluxuri:
// eveniment de start și final, sarcină utilizator, poartă exclusivă și poartă paralelă.

type Translate = (text: string) => string;
type Handler = (event: unknown, element?: unknown) => unknown;
interface Entry {
  group: string;
  className?: string;
  title?: string;
  separator?: boolean;
  action?: Record<string, Handler | null>;
}
interface ElementFactory { createShape(attrs: { type: string }): unknown }
interface Create { start(event: unknown, shape: unknown, context?: { source: unknown }): void }
interface AutoPlace { append(source: unknown, shape: unknown): void }
interface AppendPreview { create(source: unknown, type: string, options?: unknown): void; cleanUp(): void }
interface Tool { activateHand?: (e: unknown) => void; activateSelection?: (e: unknown) => void; start?: (e: unknown) => void }
interface PaletteService { registerProvider(provider: unknown): void }
interface ContextPadService { registerProvider(priority: number, provider: unknown): void }
interface Injector { get<T>(name: string, strict?: boolean): T | null }

class SeaDocPaletteProvider {
  static $inject = ['palette', 'create', 'elementFactory', 'handTool', 'lassoTool', 'spaceTool', 'globalConnect', 'translate'];

  private readonly create: Create;
  private readonly elementFactory: ElementFactory;
  private readonly handTool: Tool;
  private readonly lassoTool: Tool;
  private readonly spaceTool: Tool;
  private readonly globalConnect: Tool;
  private readonly translate: Translate;

  constructor(palette: PaletteService, create: Create, elementFactory: ElementFactory, handTool: Tool, lassoTool: Tool, spaceTool: Tool, globalConnect: Tool, translate: Translate) {
    this.create = create;
    this.elementFactory = elementFactory;
    this.handTool = handTool;
    this.lassoTool = lassoTool;
    this.spaceTool = spaceTool;
    this.globalConnect = globalConnect;
    this.translate = translate;
    palette.registerProvider(this);
  }

  getPaletteEntries(): Record<string, Entry> {
    const t = this.translate;
    const shape = (type: string, group: string, className: string, title: string): Entry => {
      const start: Handler = (event) => this.create.start(event, this.elementFactory.createShape({ type }));
      return { group, className, title: t(title), action: { dragstart: start, click: start } };
    };
    return {
      'hand-tool': { group: 'tools', className: 'bpmn-icon-hand-tool', title: t('Activate hand tool'), action: { click: (e) => this.handTool.activateHand?.(e) } },
      'lasso-tool': { group: 'tools', className: 'bpmn-icon-lasso-tool', title: t('Activate lasso tool'), action: { click: (e) => this.lassoTool.activateSelection?.(e) } },
      'space-tool': { group: 'tools', className: 'bpmn-icon-space-tool', title: t('Activate create/remove space tool'), action: { click: (e) => this.spaceTool.activateSelection?.(e) } },
      'global-connect-tool': { group: 'tools', className: 'bpmn-icon-connection-multi', title: t('Activate global connect tool'), action: { click: (e) => this.globalConnect.start?.(e) } },
      'tool-separator': { group: 'tools', separator: true },
      'create.start-event': shape('bpmn:StartEvent', 'event', 'bpmn-icon-start-event-none', 'Create start event'),
      'create.end-event': shape('bpmn:EndEvent', 'event', 'bpmn-icon-end-event-none', 'Create end event'),
      'create.user-task': shape('bpmn:UserTask', 'activity', 'bpmn-icon-user-task', 'Create user task'),
      'create.exclusive-gateway': shape('bpmn:ExclusiveGateway', 'gateway', 'bpmn-icon-gateway-xor', 'Create exclusive gateway'),
      'create.parallel-gateway': shape('bpmn:ParallelGateway', 'gateway', 'bpmn-icon-gateway-parallel', 'Create parallel gateway'),
    };
  }
}

const REMOVED = ['replace', 'append.intermediate-event', 'append.text-annotation', 'append.append-task', 'append.gateway'];

class SeaDocContextPad {
  static $inject = ['contextPad', 'create', 'elementFactory', 'injector', 'translate', 'appendPreview'];

  private readonly create: Create;
  private readonly elementFactory: ElementFactory;
  private readonly autoPlace: AutoPlace | null;
  private readonly translate: Translate;
  private readonly appendPreview: AppendPreview;

  constructor(contextPad: ContextPadService, create: Create, elementFactory: ElementFactory, injector: Injector, translate: Translate, appendPreview: AppendPreview) {
    this.create = create;
    this.elementFactory = elementFactory;
    this.autoPlace = injector.get<AutoPlace>('autoPlace', false);
    this.translate = translate;
    this.appendPreview = appendPreview;
    // Prioritate sub cea implicită (1000): rulează după furnizorul bpmn-js și îi rescrie intrările.
    contextPad.registerProvider(500, this);
  }

  private append(type: string, className: string, title: string): Entry {
    const start: Handler = (event, element) => {
      this.create.start(event, this.elementFactory.createShape({ type }), { source: element });
    };
    const place: Handler = (_, element) => {
      this.autoPlace?.append(element, this.elementFactory.createShape({ type }));
    };
    const preview: Handler = (_, element) => {
      this.appendPreview.create(element, type);
      return () => this.appendPreview.cleanUp();
    };
    return {
      group: 'model',
      className,
      title: this.translate(title),
      action: { dragstart: start, click: this.autoPlace ? place : start, hover: this.autoPlace ? preview : null },
    };
  }

  getContextPadEntries() {
    return (entries: Record<string, Entry>) => {
      // „append.end-event” există doar pentru elementele din care se poate continua fluxul.
      const canAppend = 'append.end-event' in entries;
      const out: Record<string, Entry> = {};
      for (const [id, entry] of Object.entries(entries)) {
        if (!REMOVED.includes(id)) out[id] = entry;
      }
      if (canAppend) {
        out['append.user-task'] = this.append('bpmn:UserTask', 'bpmn-icon-user-task', 'Append user task');
        out['append.exclusive-gateway'] = this.append('bpmn:ExclusiveGateway', 'bpmn-icon-gateway-xor', 'Append gateway');
        out['append.parallel-gateway'] = this.append('bpmn:ParallelGateway', 'bpmn-icon-gateway-parallel', 'Append parallel gateway');
      }
      return out;
    };
  }
}

export const seadocModule = {
  __init__: ['seadocContextPad'],
  paletteProvider: ['type', SeaDocPaletteProvider],
  seadocContextPad: ['type', SeaDocContextPad],
};
