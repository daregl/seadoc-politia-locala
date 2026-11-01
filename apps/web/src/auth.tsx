import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, onAuthLost } from './api';
import type { AuthResponse, LoginState, Permission, User } from './types';

export type AuthStatus = 'loading' | 'anon' | 'unavailable' | LoginState;

interface AuthValue {
  status: AuthStatus;
  user: User | null;
  /** Mesaj afișat pe pagina de autentificare (de exemplu sesiune expirată). */
  notice: string | null;
  applyResponse: (res: AuthResponse) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  can: (...perms: Permission[]) => boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applyResponse = useCallback((res: AuthResponse) => {
    setNotice(null);
    setStatus(res.state);
    setUser(res.user ?? null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      applyResponse(await api<AuthResponse>('/auth/me', { silentAuth: true }));
    } catch (err) {
      setUser(null);
      setStatus(err instanceof ApiError && err.status === 401 ? 'anon' : 'unavailable');
    }
  }, [applyResponse]);

  useEffect(() => {
    void refresh();
    onAuthLost((reason) => {
      if (reason === 'password') { void refresh(); return; }
      setUser(null);
      setStatus('anon');
      setNotice('Sesiunea a expirat. Autentificați-vă din nou.');
    });
    return () => onAuthLost(null);
  }, [refresh]);

  const logout = useCallback(async () => {
    let failed = false;
    try {
      await api('/auth/logout', { method: 'POST', silentAuth: true });
    } catch (err) {
      failed = !(err instanceof ApiError && err.status === 401);
    }
    setUser(null);
    setNotice(failed ? 'Deconectarea nu a putut fi confirmată de server. Închideți browserul dacă folosiți un calculator comun.' : null);
    setStatus('anon');
  }, []);

  const value = useMemo<AuthValue>(() => ({
    status, user, notice, applyResponse, refresh, logout,
    can: (...perms) => perms.some((p) => user?.permissions.includes(p)),
  }), [status, user, notice, applyResponse, refresh, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth în afara AuthProvider');
  return value;
}

/** Utilizatorul curent, în paginile accesibile doar după autentificare. */
export function useUser(): User {
  const { user } = useAuth();
  if (!user) throw new Error('Utilizator neautentificat');
  return user;
}
