import React from 'react';

/**
 * Player glyphs as inline SVG.
 *
 * Text characters were used at first, but they render at wildly different
 * weights and baselines across fonts, which is what made the control bar look
 * ragged. Drawn paths are consistent and scale cleanly.
 */
const svg = (paths, viewBox = '0 0 24 24') => function Icon({ size = 22 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {paths}
    </svg>
  );
};

export const PlayIcon = svg(<path d="M8 5.5v13l11-6.5-11-6.5z" />);
export const PauseIcon = svg(<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />);
export const NextIcon = svg(<path d="M5 5.5v13l9-6.5-9-6.5zM16 5h3v14h-3z" />);
export const PrevIcon = svg(<path d="M19 5.5v13l-9-6.5 9-6.5zM5 5h3v14H5z" />);

export const Back10Icon = svg(
  <>
    <path d="M12 5V2L7.5 5.75 12 9.5V6.5a6 6 0 1 1-6 6H4.5A7.5 7.5 0 1 0 12 5z" />
    <text x="12" y="16" fontSize="7.5" fontWeight="700" textAnchor="middle" fill="currentColor">10</text>
  </>,
);

export const Forward10Icon = svg(
  <>
    <path d="M12 5V2l4.5 3.75L12 9.5V6.5a6 6 0 1 0 6 6h1.5A7.5 7.5 0 1 1 12 5z" />
    <text x="12" y="16" fontSize="7.5" fontWeight="700" textAnchor="middle" fill="currentColor">10</text>
  </>,
);

export const VolumeIcon = svg(
  <path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4H4zm11.5-.8v6.6a3.7 3.7 0 0 0 0-6.6zm0-3.2v1.7a6.7 6.7 0 0 1 0 12.6v1.7a8.4 8.4 0 0 0 0-16z" />,
);

export const MuteIcon = svg(
  <path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4H4zm14.9 2.5 2.4-2.4-1.1-1.1-2.4 2.4-2.4-2.4-1.1 1.1 2.4 2.4-2.4 2.4 1.1 1.1 2.4-2.4 2.4 2.4 1.1-1.1z" />,
);

export const SubtitlesIcon = svg(
  <path d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm3 8.5h5V12H6v1.5zm7 0h5V12h-5v1.5zM6 16.5h8V15H6v1.5zm10 0h2V15h-2v1.5z" />,
);

export const AudioIcon = svg(
  <path d="M12 3a7 7 0 0 0-7 7v5a3 3 0 0 0 3 3h1v-7H7v-1a5 5 0 0 1 10 0v1h-2v7h1a3 3 0 0 0 3-3v-5a7 7 0 0 0-7-7z" />,
);

export const CloseIcon = svg(
  <path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4L10.6 10.6l6.3-6.3z" transform="translate(1.5 0)" />,
);

export const BackIcon = svg(<path d="M15.5 4 7 12l8.5 8 1.4-1.4L9.8 12l7.1-6.6z" />);

export const ScreenIcon = svg(
  <path d="M3 4h13a1 1 0 0 1 1 1v7h-2V6H4v8h6v2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm10 10h8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zm1 2v3h6v-3h-6z" />,
);
