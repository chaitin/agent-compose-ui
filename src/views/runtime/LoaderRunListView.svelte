<script lang="ts">
  import V2Unavailable from '../../components/V2Unavailable.svelte';
  import { V2_CAPABILITIES } from '../../lib/v2-capabilities';
</script>
<V2Unavailable title="Loader Run" reason={V2_CAPABILITIES['loader-runs'].reason} />
