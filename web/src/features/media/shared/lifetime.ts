// lifetime.ts — run `onClose` when a window's content really unmounts (the AppWindow was closed),
// not on React StrictMode's simulated unmount/remount in dev.
import { useEffect, useRef } from "react";

export function useWindowLifetime(onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  const mounted = useRef(0);
  useEffect(() => {
    mounted.current += 1;
    return () => {
      mounted.current -= 1;
      window.setTimeout(() => {
        if (mounted.current === 0) ref.current();
      }, 0);
    };
  }, []);
}
