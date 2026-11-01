import { useId, useRef, useState } from 'react';
import { fmtSize } from '../format';

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.txt,.docx,.xlsx,.pptx,.doc,.xls,.ppt';
const MAX_BYTES = 50 * 1024 * 1024;

export function FileDrop({ file, onChange, label = 'Fișier', required }: {
  file: File | null; onChange: (file: File | null) => void; label?: string; required?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const [over, setOver] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const accept = (next: File | null) => {
    setProblem(null);
    if (next) {
      const ext = next.name.split('.').pop()?.toLowerCase() ?? '';
      if (!ACCEPT.split(',').includes(`.${ext}`)) {
        setProblem(`Tip de fișier neacceptat: ${ext ? `.${ext}` : next.name}`);
        onChange(null);
        return;
      }
      if (next.size > MAX_BYTES) {
        setProblem('Fișierul depășește dimensiunea maximă admisă (50 MB).');
        onChange(null);
        return;
      }
    }
    onChange(next);
  };

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        {required && <span className="required" title="Câmp obligatoriu"> *</span>}
      </label>
      <div
        className={`dropzone ${over ? 'dropzone-over' : ''} ${file ? 'dropzone-filled' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          accept(e.dataTransfer.files[0] ?? null);
        }}
      >
        {file ? (
          <p className="dropzone-file"><strong>{file.name}</strong> <span className="muted">({fmtSize(file.size)})</span></p>
        ) : (
          <p className="dropzone-text">Trageți fișierul aici sau alegeți-l de pe dispozitiv</p>
        )}
        <input
          id={id}
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          onChange={(e) => accept(e.target.files?.[0] ?? null)}
        />
        {file && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              accept(null);
              if (inputRef.current) inputRef.current.value = '';
            }}
          >
            Elimină fișierul
          </button>
        )}
      </div>
      <span className="hint">PDF, imagini (PNG, JPEG, TIFF), TXT sau documente Office. Cel mult 50 MB.</span>
      {problem && <span className="field-error" role="alert">{problem}</span>}
    </div>
  );
}
