import { supabase } from './supabase.js';
import { BUCKET_NAME, SIGNED_URL_TTL_SECONDS, SIGNED_URL_REFRESH_MS } from './config.js';
import { requireSession, signOut } from './auth.js';

const PAGE_SIZE = 100;
const SIGN_BATCH_SIZE = 100;
const SWIPE_THRESHOLD_PX = 50;
const IMAGE_EXTENSION_RE = /\.(webp|jpe?g|png|avif)$/i;

const state = {
  photos: [],
  sections: [],
  thumbUrls: new Map(),
  fullUrlCache: new Map(),
  lastSignedAt: 0,
  refreshTimerId: null,
  isRefreshing: false,
  currentIndex: -1,
  lastTrigger: null,
  pointerSwipe: null,
  activeFilter: 'all',
  bannerPhotoNosotros: null,
  bannerPhotoAbraham: null,
  welcomeDismissed: false,
  welcomeTransitioning: false,
};

function isImageFile(name) {
  return Boolean(name) && !name.startsWith('.') && IMAGE_EXTENSION_RE.test(name);
}

function isAuthError(error) {
  if (!error) return false;
  const status = Number(error.status ?? error.statusCode ?? 0);
  const message = String(error.message || '').toLowerCase();
  return (
    status === 401 ||
    status === 403 ||
    message.includes('jwt') ||
    message.includes('expired') ||
    message.includes('unauthorized')
  );
}

/**
 * Normaliza la clave lógica de la carpeta para identificar 'nosotros' (Casados-repo)
 * y 'abraham' (Abraham-repo) sin importar mayúsculas/minúsculas.
 */
function getSectionKey(folderName) {
  const lower = String(folderName || '').trim().toLowerCase();
  if (lower === 'casados-repo' || lower.startsWith('casados') || lower === 'nosotros') {
    return 'nosotros';
  }
  if (lower === 'abraham-repo' || lower.startsWith('abraham')) {
    return 'abraham';
  }
  return lower;
}

/**
 * Devuelve el título limpio de la sección, ocultando nombres técnicos como
 * "Casados-repo" -> "Nosotros" y "Abraham-repo" -> "Abraham".
 */
function formatCleanSectionTitle(folderName, metaTitle) {
  const key = getSectionKey(folderName);
  if (key === 'nosotros') return 'Nosotros';
  if (key === 'abraham') return 'Abraham';

  if (typeof metaTitle === 'string' && metaTitle.trim()) {
    return metaTitle.trim();
  }

  const withoutRepo = String(folderName || '')
    .replace(/-repo$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!withoutRepo) return folderName;
  return withoutRepo.charAt(0).toUpperCase() + withoutRepo.slice(1);
}

function compareNames(a, b) {
  return a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });
}

async function listAllObjects(prefix = '') {
  const results = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase.storage.from(BUCKET_NAME).list(prefix, {
      limit: PAGE_SIZE,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });

    if (error) throw error;
    if (!data || data.length === 0) break;

    results.push(...data);
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return results;
}

async function loadMetaJson(rootItems) {
  const hasMeta = rootItems.some((item) => item.id !== null && item.name === 'meta.json');
  if (!hasMeta) {
    return { sections: {}, captions: {} };
  }

  try {
    const { data, error } = await supabase.storage.from(BUCKET_NAME).download('meta.json');
    if (error || !data) {
      return { sections: {}, captions: {} };
    }

    const parsed = JSON.parse(await data.text());
    return {
      sections: parsed?.sections && typeof parsed.sections === 'object' ? parsed.sections : {},
      captions: parsed?.captions && typeof parsed.captions === 'object' ? parsed.captions : {},
    };
  } catch {
    return { sections: {}, captions: {} };
  }
}

async function createSignedUrlsBatch(paths) {
  const urlMap = new Map();
  if (paths.length === 0) return urlMap;

  for (let i = 0; i < paths.length; i += SIGN_BATCH_SIZE) {
    const chunk = paths.slice(i, i + SIGN_BATCH_SIZE);
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrls(chunk, SIGNED_URL_TTL_SECONDS);

    if (error) throw error;

    for (const entry of data || []) {
      if (entry?.path && entry?.signedUrl) {
        urlMap.set(entry.path, entry.signedUrl);
      }
    }
  }

  return urlMap;
}

async function getFullSignedUrl(fullPath) {
  const cached = state.fullUrlCache.get(fullPath);
  const now = Date.now();

  if (cached && cached.expiresAt - now > 60_000) {
    return cached.url;
  }

  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(fullPath, SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    throw error || new Error('No se pudo generar la URL de la foto.');
  }

  state.fullUrlCache.set(fullPath, {
    url: data.signedUrl,
    expiresAt: now + SIGNED_URL_TTL_SECONDS * 1000,
  });

  return data.signedUrl;
}

async function fetchAlbumData() {
  const rootItems = await listAllObjects('');
  const meta = await loadMetaJson(rootItems);

  // En Supabase Storage list(), las carpetas tienen id === null.
  const folderNames = rootItems
    .filter(
      (item) =>
        item.id === null &&
        item.name &&
        item.name !== 'thumbs' &&
        !item.name.startsWith('.')
    )
    .map((item) => item.name);

  // Ordenamos priorizando "Nosotros" (Casados-repo) primero y "Abraham" (Abraham-repo) segundo
  const priorityOrder = { nosotros: 0, abraham: 1 };
  const metaOrder = Object.keys(meta.sections);

  folderNames.sort((a, b) => {
    const keyA = getSectionKey(a);
    const keyB = getSectionKey(b);
    const prioA = priorityOrder[keyA] ?? 99;
    const prioB = priorityOrder[keyB] ?? 99;
    if (prioA !== prioB) return prioA - prioB;

    const idxA = metaOrder.indexOf(a);
    const idxB = metaOrder.indexOf(b);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return compareNames(a, b);
  });

  const sections = [];
  const photos = [];

  for (const folderName of folderNames) {
    const sectionItems = await listAllObjects(folderName);
    const hasThumbsFolder = sectionItems.some(
      (item) => item.id === null && item.name === 'thumbs'
    );

    const thumbNames = new Set();
    if (hasThumbsFolder) {
      const thumbItems = await listAllObjects(`${folderName}/thumbs`);
      for (const thumb of thumbItems) {
        if (thumb.id !== null && isImageFile(thumb.name)) {
          thumbNames.add(thumb.name);
        }
      }
    }

    // Filtramos carpetas (id === null, incluyendo thumbs/) y nos quedamos solo con imágenes.
    const imageFiles = sectionItems
      .filter((item) => item.id !== null && isImageFile(item.name))
      .sort((a, b) => compareNames(a.name, b.name));

    const sectionKey = getSectionKey(folderName);
    const sectionTitle = formatCleanSectionTitle(folderName, meta.sections[folderName]);

    const sectionPhotos = imageFiles.map((file, idx) => {
      const fullPath = `${folderName}/${file.name}`;
      const thumbPath = thumbNames.has(file.name)
        ? `${folderName}/thumbs/${file.name}`
        : fullPath;
      const rawCaption = meta.captions[fullPath];
      const caption = typeof rawCaption === 'string' ? rawCaption.trim() : '';
      const photoEntry = {
        index: photos.length,
        section: folderName,
        sectionKey,
        sectionTitle,
        name: file.name,
        fullPath,
        thumbPath,
        caption,
        alt: caption || `Foto ${idx + 1} de ${sectionTitle}`,
      };
      photos.push(photoEntry);
      return photoEntry;
    });

    sections.push({
      id: `section-${sectionKey}`,
      key: sectionKey,
      folderName,
      title: sectionTitle,
      photos: sectionPhotos,
    });
  }

  const thumbPaths = photos.map((p) => p.thumbPath);
  const thumbUrls = await createSignedUrlsBatch(thumbPaths);
  state.lastSignedAt = Date.now();

  return { sections, photos, thumbUrls };
}

/**
 * Elige una foto aleatoria de una lista, procurando no repetir la actual si hay más de 1.
 */
function pickRandomPhoto(photoList, currentPhoto = null) {
  if (!Array.isArray(photoList) || photoList.length === 0) return null;
  if (photoList.length === 1) return photoList[0];

  const candidates = currentPhoto
    ? photoList.filter((p) => p.fullPath !== currentPhoto.fullPath)
    : photoList;
  const pool = candidates.length > 0 ? candidates : photoList;
  const randomIdx = Math.floor(Math.random() * pool.length);
  return pool[randomIdx];
}

/**
 * Crea un corazón SVG dibujado a mano en la capa de efectos de bienvenida.
 */
function spawnWelcomeHearts(fxLayer, originX, originY) {
  if (!fxLayer) return;

  const rect = fxLayer.getBoundingClientRect();
  const baseX = typeof originX === 'number' ? originX - rect.left : rect.width / 2;
  const baseY = typeof originY === 'number' ? originY - rect.top : rect.height / 2;

  const count = 16;
  const svgNS = 'http://www.w3.org/2000/svg';

  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'fx-heart-particle';

    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.45;
    const distance = 60 + Math.random() * 140;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance - (40 + Math.random() * 70);
    const rot = Math.round((Math.random() - 0.5) * 60);
    const scale = (0.75 + Math.random() * 0.75).toFixed(2);
    const size = Math.round(22 + Math.random() * 20);

    el.style.left = `${baseX}px`;
    el.style.top = `${baseY}px`;
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.setProperty('--dx', `${Math.round(dx)}px`);
    el.style.setProperty('--dy', `${Math.round(dy)}px`);
    el.style.setProperty('--rot', `${rot}deg`);
    el.style.setProperty('--scale', scale);

    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 40 38');
    svg.setAttribute('fill', 'none');
    svg.style.width = '100%';
    svg.style.height = '100%';

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute(
      'd',
      'M20 34C18 31 4 21 4 11.5C4 6 9 3 13.5 4C17 4.8 19 8 20 10.5C21 8 23.5 4 27.5 4C32 4 36 7.5 36 12.5C35.5 22 22 31 20 34Z'
    );
    path.setAttribute('stroke', i % 3 === 0 ? '#2a2422' : '#c93b3b');
    path.setAttribute('stroke-width', '2.3');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('fill', i % 2 === 0 ? 'rgba(201, 59, 59, 0.22)' : 'none');

    svg.appendChild(path);
    el.appendChild(svg);
    fxLayer.appendChild(el);

    window.setTimeout(() => {
      el.remove();
    }, 1000);
  }
}

function initAlbumPage() {
  const shell = document.getElementById('album-shell');
  const welcomeScreen = document.getElementById('welcome-screen');
  const welcomeFxLayer = document.getElementById('welcome-fx-layer');
  const dashboardView = document.getElementById('dashboard-view');
  const reopenWelcomeBtn = document.getElementById('btn-reopen-welcome');

  const logoutButton = document.getElementById('logout-button');
  const sectionNav = document.getElementById('section-nav');
  const sectionNavList = document.getElementById('section-nav-list');
  const statusBar = document.getElementById('album-status-bar');
  const statusText = document.getElementById('album-status');
  const retryButton = document.getElementById('retry-button');
  const sectionsContainer = document.getElementById('album-sections');
  const galleryView = document.getElementById('gallery-view');

  // Elementos de las Cards del Dashboard ("Nosotros", "Abraham" y "Carta a Mano")
  const cardNosotros = document.getElementById('card-nosotros');
  const bannerImgNosotros = document.getElementById('banner-img-nosotros');
  const bannerPlaceholderNosotros = document.getElementById('banner-placeholder-nosotros');
  const countNosotros = document.getElementById('count-nosotros');
  const shuffleNosotros = document.getElementById('shuffle-nosotros');

  const cardAbraham = document.getElementById('card-abraham');
  const bannerImgAbraham = document.getElementById('banner-img-abraham');
  const bannerPlaceholderAbraham = document.getElementById('banner-placeholder-abraham');
  const countAbraham = document.getElementById('count-abraham');
  const shuffleAbraham = document.getElementById('shuffle-abraham');

  const btnViewAll = document.getElementById('btn-view-all');
  const btnBackTop = document.getElementById('btn-back-top');
  const filterPills = document.querySelectorAll('.filter-pill');

  // Lightbox
  const lightbox = document.getElementById('lightbox');
  const lightboxShell = document.getElementById('lightbox-shell');
  const lightboxStage = document.getElementById('lightbox-stage');
  const lightboxCounter = document.getElementById('lightbox-counter');
  const lightboxClose = document.getElementById('lightbox-close');
  const lightboxLoading = document.getElementById('lightbox-loading');
  const lightboxImage = document.getElementById('lightbox-image');
  const lightboxCaption = document.getElementById('lightbox-caption');
  const lightboxPrev = document.getElementById('lightbox-prev');
  const lightboxNext = document.getElementById('lightbox-next');

  function showStatus(message, { isError = false, allowRetry = false } = {}) {
    statusText.textContent = message;
    statusText.classList.toggle('is-error', isError);
    retryButton.hidden = !allowRetry;
    statusBar.hidden = !message;
  }

  function clearStatus() {
    statusText.textContent = '';
    statusText.classList.remove('is-error');
    retryButton.hidden = true;
    statusBar.hidden = true;
  }

  /**
   * Actualiza la miniatura aleatoria de una de las 2 cards principales ("Nosotros" o "Abraham").
   */
  function updateCardBanner(key, forceNewRandom = false) {
    const isNosotros = key === 'nosotros';
    const imgEl = isNosotros ? bannerImgNosotros : bannerImgAbraham;
    const placeholderEl = isNosotros ? bannerPlaceholderNosotros : bannerPlaceholderAbraham;
    const countEl = isNosotros ? countNosotros : countAbraham;

    const section = state.sections.find((s) => s.key === key);
    const photos = section ? section.photos : [];

    if (countEl) {
      countEl.textContent =
        photos.length === 1 ? '1 recuerdo' : `${photos.length} recuerdos`;
    }

    if (!photos.length) {
      if (imgEl) imgEl.hidden = true;
      if (placeholderEl) {
        placeholderEl.textContent = 'Sin fotos aún';
        placeholderEl.hidden = false;
      }
      return;
    }

    const currentBanner = isNosotros ? state.bannerPhotoNosotros : state.bannerPhotoAbraham;
    const chosen =
      !forceNewRandom && currentBanner
        ? currentBanner
        : pickRandomPhoto(photos, currentBanner);

    if (isNosotros) {
      state.bannerPhotoNosotros = chosen;
    } else {
      state.bannerPhotoAbraham = chosen;
    }

    const signedUrl = chosen ? state.thumbUrls.get(chosen.thumbPath) : null;
    if (signedUrl && imgEl) {
      imgEl.src = signedUrl;
      imgEl.alt = chosen.alt || (isNosotros ? 'Foto de Nosotros' : 'Foto de Abraham');
      imgEl.dataset.thumbPath = chosen.thumbPath;
      imgEl.hidden = false;
      if (placeholderEl) placeholderEl.hidden = true;
    } else if (placeholderEl) {
      placeholderEl.textContent = 'Recuerdo listo';
      placeholderEl.hidden = false;
    }
  }

  /**
   * Filtra las secciones visibles en la galería ("all", "nosotros", "abraham")
   * y opcionalmente hace scroll suave hacia la galería.
   */
  function applyGalleryFilter(filterKey, { scrollToGallery = false } = {}) {
    state.activeFilter = filterKey;

    for (const pill of filterPills) {
      const isMatch = pill.dataset.filter === filterKey;
      pill.classList.toggle('is-active', isMatch);
      pill.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    }

    const sectionEls = sectionsContainer.querySelectorAll('.album-section');
    for (const secEl of sectionEls) {
      const secKey = secEl.dataset.sectionKey;
      secEl.hidden = filterKey !== 'all' && secKey !== filterKey;
    }

    if (scrollToGallery && galleryView) {
      galleryView.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function renderGallery(sections, thumbUrls) {
    sectionNavList.textContent = '';
    sectionsContainer.textContent = '';
    sectionNav.hidden = true;

    // Actualizamos los banners aleatorios de las cards "Nosotros" (Casados-repo) y "Abraham" (Abraham-repo)
    updateCardBanner('nosotros', true);
    updateCardBanner('abraham', true);

    if (sections.length === 0) {
      showStatus('Todavía no hay fotos en el álbum.');
      return;
    }

    for (const section of sections) {
      const sectionEl = document.createElement('section');
      sectionEl.id = section.id;
      sectionEl.className = 'album-section';
      sectionEl.dataset.sectionKey = section.key;
      sectionEl.setAttribute('aria-labelledby', `${section.id}-title`);

      const heading = document.createElement('h2');
      heading.id = `${section.id}-title`;
      heading.className = 'album-section-title';
      heading.textContent = section.title;
      sectionEl.appendChild(heading);

      if (section.photos.length === 0) {
        const emptyMsg = document.createElement('p');
        emptyMsg.className = 'section-empty';
        emptyMsg.textContent = 'Esta sección aún no tiene fotos.';
        sectionEl.appendChild(emptyMsg);
      } else {
        const grid = document.createElement('ul');
        grid.className = 'photo-grid';

        for (const photo of section.photos) {
          const item = document.createElement('li');
          item.className = 'photo-item';

          const trigger = document.createElement('button');
          trigger.type = 'button';
          trigger.className = 'photo-trigger';
          trigger.dataset.photoIndex = String(photo.index);
          trigger.setAttribute('aria-label', `Ver ${photo.alt}`);

          const img = document.createElement('img');
          img.className = 'photo-thumb';
          img.loading = 'lazy';
          img.decoding = 'async';
          img.width = 400;
          img.height = 300;
          img.alt = photo.alt;
          img.dataset.thumbPath = photo.thumbPath;

          const signedUrl = thumbUrls.get(photo.thumbPath);
          if (signedUrl) {
            img.src = signedUrl;
          }

          trigger.appendChild(img);
          item.appendChild(trigger);
          grid.appendChild(item);
        }

        sectionEl.appendChild(grid);
      }

      sectionsContainer.appendChild(sectionEl);
    }

    applyGalleryFilter(state.activeFilter, { scrollToGallery: false });
  }

  async function renderLightboxPhoto(index) {
    const photo = state.photos[index];
    if (!photo) return;

    state.currentIndex = index;
    lightboxCounter.textContent = `${photo.sectionTitle} — ${index + 1} / ${state.photos.length}`;
    lightboxPrev.disabled = state.photos.length <= 1;
    lightboxNext.disabled = state.photos.length <= 1;

    lightboxLoading.textContent = 'Cargando recuerdo…';
    lightboxLoading.hidden = false;
    lightboxImage.hidden = true;
    lightboxImage.removeAttribute('src');

    if (photo.caption) {
      lightboxCaption.textContent = photo.caption;
      lightboxCaption.hidden = false;
    } else {
      lightboxCaption.textContent = '';
      lightboxCaption.hidden = true;
    }

    try {
      const signedUrl = await getFullSignedUrl(photo.fullPath);
      if (state.currentIndex !== index || !lightbox.open) return;

      lightboxImage.alt = photo.alt;
      lightboxImage.onload = () => {
        if (state.currentIndex !== index) return;
        lightboxLoading.hidden = true;
        lightboxImage.hidden = false;
      };
      lightboxImage.onerror = () => {
        if (state.currentIndex !== index) return;
        lightboxLoading.textContent = 'No se pudo cargar esta foto.';
        lightboxLoading.hidden = false;
        lightboxImage.hidden = true;
      };
      lightboxImage.src = signedUrl;
    } catch (error) {
      if (isAuthError(error)) {
        await signOut();
        return;
      }
      if (state.currentIndex === index) {
        lightboxLoading.textContent = 'Error de conexión al cargar la foto.';
        lightboxLoading.hidden = false;
      }
    }
  }

  function openLightbox(index, triggerElement) {
    if (index < 0 || index >= state.photos.length) return;
    state.lastTrigger = triggerElement || document.activeElement;

    if (!lightbox.open) {
      lightbox.showModal();
    }

    renderLightboxPhoto(index);
    lightboxClose.focus();
  }

  function stepLightbox(delta) {
    if (state.photos.length <= 1 || state.currentIndex < 0) return;
    const nextIndex = (state.currentIndex + delta + state.photos.length) % state.photos.length;
    renderLightboxPhoto(nextIndex);
  }

  async function refreshSignedUrls() {
    if (state.isRefreshing || state.photos.length === 0) return;
    state.isRefreshing = true;

    try {
      state.fullUrlCache.clear();
      const thumbPaths = state.photos.map((p) => p.thumbPath);
      const freshUrls = await createSignedUrlsBatch(thumbPaths);
      state.thumbUrls = freshUrls;
      state.lastSignedAt = Date.now();

      const imgs = document.querySelectorAll('img[data-thumb-path]');
      for (const img of imgs) {
        const path = img.dataset.thumbPath;
        const freshUrl = freshUrls.get(path);
        if (freshUrl && img.src !== freshUrl) {
          img.src = freshUrl;
        }
      }

      if (lightbox.open && state.currentIndex >= 0) {
        renderLightboxPhoto(state.currentIndex);
      }
    } catch (error) {
      if (isAuthError(error)) {
        window.location.replace('index.html?expired=1');
      }
    } finally {
      state.isRefreshing = false;
    }
  }

  function startRefreshSchedule() {
    if (state.refreshTimerId !== null) {
      window.clearInterval(state.refreshTimerId);
    }

    state.refreshTimerId = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        refreshSignedUrls();
      }
    }, SIGNED_URL_REFRESH_MS);
  }

  async function loadGallery() {
    showStatus('Cargando nuestros recuerdos…');

    try {
      const { sections, photos, thumbUrls } = await fetchAlbumData();
      state.sections = sections;
      state.photos = photos;
      state.thumbUrls = thumbUrls;
      clearStatus();
      renderGallery(sections, thumbUrls);
      startRefreshSchedule();
    } catch (error) {
      if (isAuthError(error)) {
        window.location.replace('index.html?expired=1');
        return;
      }
      showStatus('No se pudo cargar el álbum. Revisa tu conexión e inténtalo de nuevo.', {
        isError: true,
        allowRetry: true,
      });
    }
  }

  // =========================================================================
  // Interacción de la Pantalla de Bienvenida ("Con Amor para Catalina")
  // =========================================================================
  function advanceFromWelcome(clientX, clientY) {
    if (!welcomeScreen || !dashboardView) return;

    welcomeScreen.classList.add('is-excited');
    spawnWelcomeHearts(welcomeFxLayer, clientX, clientY);

    if (state.welcomeTransitioning) return;
    state.welcomeTransitioning = true;

    window.setTimeout(() => {
      welcomeScreen.classList.add('is-leaving');
      window.setTimeout(() => {
        welcomeScreen.hidden = true;
        welcomeScreen.classList.remove('is-leaving', 'is-excited');
        dashboardView.hidden = false;
        state.welcomeDismissed = true;
        state.welcomeTransitioning = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }, 360);
    }, 520);
  }

  if (welcomeScreen) {
    welcomeScreen.addEventListener('click', (event) => {
      advanceFromWelcome(event.clientX, event.clientY);
    });

    welcomeScreen.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        advanceFromWelcome();
      }
    });
  }

  if (reopenWelcomeBtn && welcomeScreen && dashboardView) {
    reopenWelcomeBtn.addEventListener('click', () => {
      dashboardView.hidden = true;
      welcomeScreen.hidden = false;
      state.welcomeDismissed = false;
      state.welcomeTransitioning = false;
    });
  }

  // =========================================================================
  // Interacción de las Cards ("Nosotros", "Abraham" y "Carta a Mano")
  // =========================================================================
  if (shuffleNosotros) {
    shuffleNosotros.addEventListener('click', (event) => {
      event.stopPropagation();
      updateCardBanner('nosotros', true);
    });
  }

  if (shuffleAbraham) {
    shuffleAbraham.addEventListener('click', (event) => {
      event.stopPropagation();
      updateCardBanner('abraham', true);
    });
  }

  if (cardNosotros) {
    cardNosotros.addEventListener('click', () => {
      applyGalleryFilter('nosotros', { scrollToGallery: true });
    });
    cardNosotros.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        applyGalleryFilter('nosotros', { scrollToGallery: true });
      }
    });
  }

  if (cardAbraham) {
    cardAbraham.addEventListener('click', () => {
      applyGalleryFilter('abraham', { scrollToGallery: true });
    });
    cardAbraham.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        applyGalleryFilter('abraham', { scrollToGallery: true });
      }
    });
  }

  if (btnViewAll) {
    btnViewAll.addEventListener('click', () => {
      applyGalleryFilter('all', { scrollToGallery: true });
    });
  }

  if (btnBackTop) {
    btnBackTop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  for (const pill of filterPills) {
    pill.addEventListener('click', () => {
      const filterKey = pill.dataset.filter || 'all';
      applyGalleryFilter(filterKey, { scrollToGallery: false });
    });
  }

  // Eventos generales de UI
  logoutButton.addEventListener('click', () => {
    if (state.refreshTimerId !== null) {
      window.clearInterval(state.refreshTimerId);
    }
    signOut();
  });

  retryButton.addEventListener('click', () => {
    loadGallery();
  });

  sectionsContainer.addEventListener('click', (event) => {
    const trigger = event.target.closest('.photo-trigger');
    if (!trigger) return;
    const index = Number(trigger.dataset.photoIndex);
    if (!Number.isNaN(index)) {
      openLightbox(index, trigger);
    }
  });

  lightboxClose.addEventListener('click', () => lightbox.close());
  lightboxPrev.addEventListener('click', () => stepLightbox(-1));
  lightboxNext.addEventListener('click', () => stepLightbox(1));

  // Cierre explícito al tocar fuera de la foto o controles (backdrop del <dialog>).
  lightbox.addEventListener('click', (event) => {
    if (
      event.target === lightbox ||
      event.target === lightboxShell ||
      event.target === lightboxStage
    ) {
      lightbox.close();
    }
  });

  lightbox.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      stepLightbox(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      stepLightbox(1);
    }
  });

  // Navegación táctil por swipe usando Pointer Events en el área de la foto.
  lightboxStage.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    state.pointerSwipe = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
  });

  lightboxStage.addEventListener('pointerup', (event) => {
    if (!state.pointerSwipe || event.pointerId !== state.pointerSwipe.id) return;

    const dx = event.clientX - state.pointerSwipe.startX;
    const dy = event.clientY - state.pointerSwipe.startY;
    state.pointerSwipe = null;

    if (Math.abs(dx) >= SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy) * 1.2) {
      stepLightbox(dx < 0 ? 1 : -1);
    }
  });

  lightboxStage.addEventListener('pointercancel', (event) => {
    if (state.pointerSwipe && event.pointerId === state.pointerSwipe.id) {
      state.pointerSwipe = null;
    }
  });

  lightbox.addEventListener('close', () => {
    state.currentIndex = -1;
    state.pointerSwipe = null;
    lightboxImage.removeAttribute('src');
    lightboxImage.hidden = true;
    lightboxLoading.hidden = true;

    if (state.lastTrigger && typeof state.lastTrigger.focus === 'function') {
      state.lastTrigger.focus();
    }
    state.lastTrigger = null;
  });

  document.addEventListener('visibilitychange', () => {
    if (
      document.visibilityState === 'visible' &&
      state.lastSignedAt > 0 &&
      Date.now() - state.lastSignedAt >= SIGNED_URL_REFRESH_MS
    ) {
      refreshSignedUrls();
    }
  });

  // Arranque protegido por sesión
  requireSession(() => {
    if (state.refreshTimerId !== null) {
      window.clearInterval(state.refreshTimerId);
    }
    shell.hidden = true;
  }).then((authContext) => {
    if (!authContext) return;
    shell.hidden = false;
    loadGallery();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAlbumPage);
} else {
  initAlbumPage();
}
