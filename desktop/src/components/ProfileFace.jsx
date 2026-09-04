import React from 'react';
import { apiBaseUrl } from '../api.js';

/**
 * A profile's face: their own picture, or their initial on their colour.
 *
 * The picture's address never changes, so the time it was set is added to the
 * query — otherwise a browser that already has the old one would keep showing
 * it after somebody chose a new photograph.
 */
/**
 * @param {'picker'|'large'|'list'} size Where it is being shown. "picker" is
 *   the full-size tile on the who's-watching screen and the default, because
 *   defaulting to the small one silently shrank that screen to thumbnails.
 */
export function ProfileFace({ profile, size = 'picker' }) {
  const initial = [...(profile?.name ?? '?')][0]?.toUpperCase() ?? '?';
  const className = 'profile-face'
    + (size === 'large' ? ' profile-face-large' : '')
    + (size === 'list' ? ' profile-face-small' : '');

  if (profile?.avatarAt) {
    return (
      <img
        className={className + ' has-photo'}
        src={apiBaseUrl() + '/api/profiles/' + encodeURIComponent(profile.id)
          + '/avatar?v=' + profile.avatarAt}
        alt=""
        draggable={false}
      />
    );
  }

  return (
    <span className={className} style={{ background: profile?.colour }} aria-hidden="true">
      {initial}
    </span>
  );
}

export default ProfileFace;
