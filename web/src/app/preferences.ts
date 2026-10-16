const ANIMATIONS_KEY = 'aic.animations';

/** Animations de l'interface : activées par défaut ; le stockage peut être indisponible (navigation privée…). */
export function getAnimationsPreference(): boolean {
  try {
    return localStorage.getItem(ANIMATIONS_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setAnimationsPreference(on: boolean): void {
  try {
    localStorage.setItem(ANIMATIONS_KEY, on ? 'on' : 'off');
  } catch {
    // Préférence non mémorisée : sans effet sur le reste de l'interface.
  }
}

/** Reflète la préférence sur <html> (lu par theme.css). */
export function applyAnimationsPreference(on: boolean): void {
  document.documentElement.dataset.animations = on ? 'on' : 'off';
}
