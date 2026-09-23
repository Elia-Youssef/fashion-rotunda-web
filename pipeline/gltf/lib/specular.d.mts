export interface SpecularState {
  factor?: number;
  color?: number[];
  hasSpecularTexture?: boolean;
  hasSpecularColorTexture?: boolean;
}

export declare const DEFAULT_SPECULAR_FACTOR: number;
export declare const DEFAULT_SPECULAR_COLOR: number[];
export declare function shouldPreserveSpecular(state?: SpecularState): boolean;
