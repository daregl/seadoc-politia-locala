import { useEffect, useRef, useState } from 'react';
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import { Alert } from '../components/Ui';
import { moddleExtensions } from './descriptor';
import type { Canvas, ElementRegistry, Overlays } from './services';

export interface ViewerServices { canvas: Canvas; registry: ElementRegistry; overlays: Overlays }

/** Afișează o diagramă BPMN doar pentru consultare, cu zoom din butoane și deplasare tactilă. */
export default function DiagramViewer({ xml, label, decorate }: {
  xml: string; label: string; decorate?: (services: ViewerServices) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<Canvas | null>(null);
  const fitScale = useRef(1);
  const [failed, setFailed] = useState(false);
  const decorateRef = useRef(decorate);
  decorateRef.current = decorate;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    setFailed(false);
    const viewer = new NavigatedViewer({ container, moddleExtensions });
    const canvas = viewer.get<Canvas>('canvas');
    canvasRef.current = canvas;

    const fit = () => {
      canvas.zoom('fit-viewport', 'auto');
      // Spațiu pentru etichetele de stare, care ies din conturul elementelor.
      canvas.zoom(canvas.zoom() * 0.92, 'auto');
      fitScale.current = canvas.zoom();
      container.style.touchAction = 'pan-y';
    };

    viewer.importXML(xml).then(() => {
      if (cancelled) return;
      fit();
      decorateRef.current?.({
        canvas,
        registry: viewer.get<ElementRegistry>('elementRegistry'),
        overlays: viewer.get<Overlays>('overlays'),
      });
    }).catch((err: unknown) => {
      console.error(err);
      if (!cancelled) setFailed(true);
    });

    const observer = new ResizeObserver(() => canvas.resized());
    observer.observe(container);

    // Pe ecran tactil, diagrama mărită se deplasează cu degetul; altfel pagina derulează normal.
    let last: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => { if (e.pointerType === 'touch') last = { x: e.clientX, y: e.clientY }; };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !last) return;
      const zoomed = container.style.touchAction === 'none';
      canvas.scroll({ dx: e.clientX - last.x, dy: zoomed ? e.clientY - last.y : 0 });
      last = { x: e.clientX, y: e.clientY };
    };
    const up = () => { last = null; };
    container.addEventListener('pointerdown', down);
    container.addEventListener('pointermove', move);
    container.addEventListener('pointerup', up);
    container.addEventListener('pointercancel', up);

    return () => {
      cancelled = true;
      observer.disconnect();
      container.removeEventListener('pointerdown', down);
      container.removeEventListener('pointermove', move);
      container.removeEventListener('pointerup', up);
      container.removeEventListener('pointercancel', up);
      canvasRef.current = null;
      viewer.destroy();
    };
  }, [xml]);

  const zoomBy = (factor: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !containerRef.current) return;
    canvas.zoom(canvas.zoom() * factor, 'auto');
    containerRef.current.style.touchAction = canvas.zoom() > fitScale.current * 1.05 ? 'none' : 'pan-y';
  };
  const fitView = () => {
    const canvas = canvasRef.current;
    if (!canvas || !containerRef.current) return;
    canvas.zoom('fit-viewport', 'auto');
    canvas.zoom(canvas.zoom() * 0.92, 'auto');
    fitScale.current = canvas.zoom();
    containerRef.current.style.touchAction = 'pan-y';
  };

  return (
    <div className="diagram">
      {failed && <Alert kind="error">Diagrama nu a putut fi afișată. Pașii fluxului rămân disponibili în tabelul de mai jos.</Alert>}
      <div className="diagram-tools" role="group" aria-label="Zoom diagramă">
        <button type="button" className="btn btn-sm" onClick={() => zoomBy(1.25)}>Mărește</button>
        <button type="button" className="btn btn-sm" onClick={() => zoomBy(0.8)}>Micșorează</button>
        <button type="button" className="btn btn-sm" onClick={fitView}>Încadrează</button>
      </div>
      <div className="diagram-canvas" ref={containerRef} role="group" aria-label={label} />
    </div>
  );
}
