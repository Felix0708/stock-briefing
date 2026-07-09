// Next.js 공식 flat config 방식 (FlatCompat).
// eslint-config-next는 구형(eslintrc) 형식이라 compat 레이어로 불러온다.
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { ignores: [".next/**", "out/**", "build/**", "next-env.d.ts"] },
];
