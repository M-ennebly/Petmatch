export const PLANS = {
    FREE: {
        name: "Free",
        price: 0,
        monthlyMessageLimit: 500,
        productLimit: 50,
        hasCustomBranding: false,
        hasAnalytics: false,
    },
    GROWTH: {
        name: "Growth",
        price: 29,
        monthlyMessageLimit: 5000,
        productLimit: 500,
        hasCustomBranding: true,
        hasAnalytics: true,
    },
    PRO: {
        name: "Pro",
        price: 59,
        monthlyMessageLimit: -1, // unlimited
        productLimit: -1,        // unlimited
        hasCustomBranding: true,
        hasAnalytics: true,
    },
} as const;

export type PlanKey = keyof typeof PLANS;
