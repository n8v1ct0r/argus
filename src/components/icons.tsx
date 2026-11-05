// Authored icons, one stroke weight (1.5) on a 16 unit grid, drawn in currentColor.
import type { SVGProps } from "react";

function Icon(props: SVGProps<SVGSVGElement> & { children: React.ReactNode }) {
  const { children, ...rest } = props;
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const PlayIcon = () => (
  <Icon>
    <path d="M5 3.5v9l7-4.5z" />
  </Icon>
);

export const PauseIcon = () => (
  <Icon>
    <path d="M5.5 3.5v9M10.5 3.5v9" />
  </Icon>
);

export const BackIcon = () => (
  <Icon>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </Icon>
);

export const SendIcon = () => (
  <Icon>
    <path d="M2.5 8h10M8.5 4l4 4-4 4" />
  </Icon>
);

/** A small stylus trace: the Argus mark. */
export const ArgusMark = () => (
  <svg viewBox="0 0 32 32" width="20" height="20" aria-hidden="true" focusable="false">
    <path
      d="M3 17h7l2-9 3 16 2.5-11 1.5 4h10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  </svg>
);

export const CloseIcon = () => (
  <Icon>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </Icon>
);

export const SearchIcon = () => (
  <Icon>
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.25 10.25 13.5 13.5" />
  </Icon>
);

export const BellIcon = () => (
  <Icon>
    <path d="M4 11.5V7.25a4 4 0 0 1 8 0v4.25l1 1H3z" />
    <path d="M6.75 14h2.5" />
  </Icon>
);

export const ListIcon = () => (
  <Icon>
    <path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01" />
  </Icon>
);

export const PinIcon = () => (
  <Icon>
    <circle cx="8" cy="7" r="2" />
    <path d="M8 14.5s-4.5-4-4.5-7.5a4.5 4.5 0 0 1 9 0c0 3.5-4.5 7.5-4.5 7.5z" />
  </Icon>
);

export const StackIcon = () => (
  <Icon>
    <path d="M8 2.5 14 5.5 8 8.5 2 5.5z" />
    <path d="M2 8.25 8 11.25 14 8.25M2 11 8 14 14 11" />
  </Icon>
);

export const ClockIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 5v3.25l2 1.25" />
  </Icon>
);
