import { supabase, isSupabaseConfigured } from './supabase.js';

function redirectTo(path) {
  window.location.replace(path);
}

/**
 * Guard de sesión para páginas protegidas (como album.html).
 * Nota de seguridad: ocultar la UI y redirigir en JS es solo experiencia de usuario (UX);
 * la seguridad real recae en las políticas RLS de Supabase Storage, que rechazan cualquier
 * solicitud sin una sesión autenticada válida.
 */
export async function requireSession(onAuthLost) {
  if (!isSupabaseConfigured() || !supabase) {
    redirectTo('index.html');
    return null;
  }

  try {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data?.session) {
      redirectTo('index.html?expired=1');
      return null;
    }

    const { data: subscriptionData } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        if (typeof onAuthLost === 'function') {
          onAuthLost();
        }
        redirectTo('index.html?expired=1');
      }
    });

    return {
      session: data.session,
      unsubscribe: () => subscriptionData?.subscription?.unsubscribe(),
    };
  } catch {
    redirectTo('index.html');
    return null;
  }
}

export async function signOut() {
  if (supabase) {
    try {
      await supabase.auth.signOut();
    } catch {
      // Incluso si falla la llamada de red, limpiamos la vista y volvemos al login.
    }
  }
  redirectTo('index.html');
}

function getFriendlyLoginError(error) {
  const message = (error?.message || '').toLowerCase();

  if (
    error?.status === 400 ||
    message.includes('invalid login credentials') ||
    message.includes('invalid_credentials')
  ) {
    return 'Correo o contraseña incorrectos.';
  }

  if (message.includes('failed to fetch') || message.includes('network') || error?.status === 0) {
    return 'No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.';
  }

  if (error?.status === 429 || message.includes('rate limit')) {
    return 'Demasiados intentos seguidos. Espera unos minutos e inténtalo otra vez.';
  }

  return 'No se pudo iniciar sesión. Inténtalo de nuevo.';
}

async function initLoginPage() {
  const main = document.getElementById('login-main');
  const form = document.getElementById('login-form');
  if (!main || !form) return;

  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const submitButton = document.getElementById('login-submit');
  const feedback = document.getElementById('login-feedback');

  const showFeedback = (text, isError = true) => {
    feedback.textContent = text;
    feedback.classList.toggle('is-error', isError);
    feedback.hidden = !text;
  };

  if (!isSupabaseConfigured() || !supabase) {
    main.hidden = false;
    showFeedback('Falta configurar SUPABASE_URL y SUPABASE_ANON_KEY en js/config.js.');
    submitButton.disabled = true;
    return;
  }

  // Si ya existe sesión válida, vamos directo al álbum sin mostrar el formulario.
  try {
    const { data } = await supabase.auth.getSession();
    if (data?.session) {
      redirectTo('album.html');
      return;
    }
  } catch {
    // Si falla la comprobación inicial, mostramos el formulario para permitir acceso manual.
  }

  main.hidden = false;

  const params = new URLSearchParams(window.location.search);
  if (params.get('expired') === '1') {
    showFeedback('Tu sesión expiró. Inicia sesión de nuevo.', false);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showFeedback('');

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      showFeedback('Escribe tu correo y contraseña.');
      return;
    }

    submitButton.disabled = true;
    submitButton.setAttribute('aria-busy', 'true');
    submitButton.textContent = 'Entrando…';

    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });

      if (error || !data?.session) {
        showFeedback(getFriendlyLoginError(error));
        passwordInput.value = '';
        passwordInput.focus();
        return;
      }

      redirectTo('album.html');
    } catch (err) {
      showFeedback(getFriendlyLoginError(err));
    } finally {
      submitButton.disabled = false;
      submitButton.removeAttribute('aria-busy');
      submitButton.textContent = 'Entrar';
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLoginPage);
} else {
  initLoginPage();
}
