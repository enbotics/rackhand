"use client";

import { useEffect, useState } from "react";

/**
 * The operator's motion preference, as a value React can branch on.
 *
 * The CSS in globals.css already silences every `.animate-*` class under
 * `prefers-reduced-motion`, which is enough for decoration. It is NOT enough
 * for anything whose motion is inline — a transition driven by a style
 * attribute, or a fade the component must know it can skip — so those read the
 * preference here instead and drop the motion while keeping the information.
 *
 * Starts pessimistic (`true`) so a server render and the first client paint
 * agree on the still version, then corrects itself on mount.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(true);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  return reduced;
}
