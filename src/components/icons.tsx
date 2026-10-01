import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.2 5.6v12.8a.6.6 0 0 0 .92.5l9.9-6.4a.6.6 0 0 0 0-1L9.12 5.1a.6.6 0 0 0-.92.5z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6.8" y="5.5" width="3.4" height="13" rx="1.1" fill="currentColor" stroke="none" />
      <rect x="13.8" y="5.5" width="3.4" height="13" rx="1.1" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function VolumeIcon({ level, ...props }: IconProps & { level: number }) {
  return (
    <Icon {...props}>
      <path d="M4.5 9.6h2.9l4.1-3.6v12l-4.1-3.6H4.5a.5.5 0 0 1-.5-.5V10.1a.5.5 0 0 1 .5-.5z" fill="currentColor" stroke="none" />
      {level <= 0 ? (
        <path d="M15.6 9.6l4.8 4.8M20.4 9.6l-4.8 4.8" />
      ) : (
        <>
          <path d="M15.2 9.3a3.9 3.9 0 0 1 0 5.4" />
          {level > 0.5 && <path d="M17.9 6.9a7.4 7.4 0 0 1 0 10.2" />}
        </>
      )}
    </Icon>
  );
}

export function FullscreenIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 9V5.6a1.1 1.1 0 0 1 1.1-1.1H9M15 4.5h3.4a1.1 1.1 0 0 1 1.1 1.1V9M19.5 15v3.4a1.1 1.1 0 0 1-1.1 1.1H15M9 19.5H5.6a1.1 1.1 0 0 1-1.1-1.1V15" />
    </Icon>
  );
}

export function ExitFullscreenIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 4.5v3.4A1.1 1.1 0 0 1 7.9 9H4.5M19.5 9h-3.4A1.1 1.1 0 0 1 15 7.9V4.5M15 19.5v-3.4a1.1 1.1 0 0 1 1.1-1.1h3.4M4.5 15h3.4A1.1 1.1 0 0 1 9 16.1v3.4" />
    </Icon>
  );
}

export function HideIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 3.5l17 17" />
      <path d="M10.4 5.2c.5-.1 1-.1 1.6-.1 4.9 0 8.2 4.3 9.3 6.1.3.5.3 1.1 0 1.6-.5.8-1.3 1.9-2.4 3" />
      <path d="M6.7 6.8C4.8 8 3.4 9.8 2.7 11.1c-.3.5-.3 1.1 0 1.6 1.1 1.8 4.4 6.1 9.3 6.1 1.8 0 3.3-.5 4.6-1.3" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </Icon>
  );
}

export function SlidersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7.5h9M17.5 7.5H20M4 16.5h3M11.5 16.5H20" />
      <circle cx="15.2" cy="7.5" r="2.1" />
      <circle cx="9.2" cy="16.5" r="2.1" />
    </Icon>
  );
}

export function FlameIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 21c-3.6 0-6.2-2.6-6.2-6 0-2.7 1.6-4.6 3.1-6.3.9-1 1.7-2.1 2.1-3.7.1-.4.6-.5.8-.2 2.6 2.6 6.4 6.3 6.4 10.2 0 3.4-2.6 6-6.2 6z" />
      <path d="M12 21c-1.6 0-2.8-1.2-2.8-2.9 0-1.6 1.2-2.6 2.2-3.8.2-.3.6-.3.8 0 1 1.2 2.6 2.4 2.6 3.8 0 1.7-1.2 2.9-2.8 2.9z" />
    </Icon>
  );
}
