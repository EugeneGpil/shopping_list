<template>
  <!-- iOS has no install prompt, so the app has to say the words itself. One grey line in
       the same voice as the other notices on this page, and it goes away for good when
       dismissed — a hint that keeps coming back is an advert. -->
  <div v-if="show" class="row items-center no-wrap q-gutter-xs q-mb-sm text-grey">
    <q-icon name="ios_share" size="16px" />
    <span class="text-caption"> To install: tap Share, then “Add to Home Screen” </span>
    <q-btn
      flat
      round
      dense
      size="xs"
      icon="close"
      color="grey"
      aria-label="Dismiss"
      @click="hide"
    />
  </div>
</template>

<script>
import { dismissInstallHint, shouldOfferInstallHint } from 'src/utils/installHint'

export default {
  name: 'InstallHint',

  data() {
    // Decided once, when the component is created: nothing that feeds the decision can change
    // while the page is open — an install is a new window, not a state change in this one.
    return { show: shouldOfferInstallHint() }
  },

  methods: {
    hide() {
      dismissInstallHint()
      this.show = false
    },
  },
}
</script>
