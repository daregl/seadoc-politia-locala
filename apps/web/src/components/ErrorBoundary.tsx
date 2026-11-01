import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State { failed: boolean; chunk: boolean }

/** Prinde erorile de afișare și încărcarea eșuată a modulelor, ca pagina să nu rămână goală. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  state: State = { failed: false, chunk: false };

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : '';
    return { failed: true, chunk: /dynamically imported module|Importing a module script|error loading/i.test(message) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false, chunk: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="alert alert-error" role="alert">
        <p className="alert-title">{this.state.chunk ? 'Pagina nu a putut fi încărcată' : 'A apărut o eroare la afișarea paginii'}</p>
        <p>{this.state.chunk ? 'Verificați conexiunea. Este posibil ca aplicația să fi fost actualizată între timp.' : 'Reîncărcați pagina. Dacă problema persistă, contactați administratorul.'}</p>
        <button type="button" className="btn btn-sm alert-action" onClick={() => window.location.reload()}>Reîncarcă pagina</button>
      </div>
    );
  }
}
