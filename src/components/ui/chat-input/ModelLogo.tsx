import React from "react";
import type { Model } from "./types";

export const ModelLogo: React.FC<{ model: Pick<Model, "logo" | "logoMono">; className: string }> = ({ model, className }) => {
    if (!model.logo) return null;
    // Single-colour logos are drawn as a mask so they take the text colour and stay visible in dark mode.
    if (model.logoMono) {
        return (
            <span
                aria-hidden
                className={`${className} shrink-0 bg-current`}
                style={{ mask: `url(${model.logo}) center / contain no-repeat`, WebkitMask: `url(${model.logo}) center / contain no-repeat` }}
            />
        );
    }
    return <img src={model.logo} alt="" className={`${className} shrink-0 object-contain`} />;
};
