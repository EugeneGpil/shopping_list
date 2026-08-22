const routes = [
  {
    path: '/login',
    component: () => import('pages/LoginPage.vue'),
  },
  {
    path: '/',
    component: () => import('layouts/MainLayout.vue'),
    children: [
      { path: '', component: () => import('pages/ShoppingListsPage.vue') },
      { path: 'list/:id', component: () => import('pages/ShoppingListPage.vue') },
      // The same pair as above, for what has been deleted and is not gone yet. Inside the
      // layout like the rest, so the sync triggers it owns keep running while the trash is open.
      { path: 'trash', component: () => import('pages/TrashPage.vue') },
      { path: 'trash/list/:id', component: () => import('pages/TrashedListPage.vue') },
    ],
  },

  {
    path: '/:catchAll(.*)*',
    component: () => import('pages/ErrorNotFound.vue'),
  },
]

export default routes
