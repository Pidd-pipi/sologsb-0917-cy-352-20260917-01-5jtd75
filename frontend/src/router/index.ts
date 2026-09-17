import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "overview",
      component: () => import("../pages/OverviewPage.vue"),
      meta: { title: "运营总览" },
    },
    {
      path: "/records",
      name: "records",
      component: () => import("../pages/RecordsPage.vue"),
      meta: { title: "战绩与排行榜" },
    },
  ],
});
