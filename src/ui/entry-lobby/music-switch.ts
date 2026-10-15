import { resolveMusicPreference, storeMusicPreference } from '../../audio/preference';
import type { KeyValueStore, MusicPreference } from '../../audio/preference';

export function createLobbyMusicSwitch(
  musicSwitchBtn: HTMLButtonElement | null,
  search: string,
  store: KeyValueStore | null,
  signal: AbortSignal,
): { readonly preference: MusicPreference } {
  const musicLabel = musicSwitchBtn?.querySelector<HTMLElement>('.music-switch__label') ?? null;
  let currentMusicPreference = resolveMusicPreference(search, store);

  function syncMusicSwitchUI(): void {
    if (musicSwitchBtn === null) {
      return;
    }
    const isPlaying = currentMusicPreference === 'on';
    musicSwitchBtn.dataset['music'] = isPlaying ? 'armed' : 'off';
    musicSwitchBtn.setAttribute('aria-pressed', isPlaying ? 'true' : 'false');
    if (musicLabel !== null) {
      musicLabel.textContent = isPlaying ? 'Music on' : 'Music off';
    }
  }
  syncMusicSwitchUI();

  // Toggle music preference before Load Experience
  if (musicSwitchBtn !== null) {
    musicSwitchBtn.addEventListener(
      'click',
      () => {
        currentMusicPreference = currentMusicPreference === 'on' ? 'off' : 'on';
        storeMusicPreference(store, currentMusicPreference);
        syncMusicSwitchUI();
      },
      { signal },
    );
  }

  return {
    get preference(): MusicPreference {
      return currentMusicPreference;
    },
  };
}
