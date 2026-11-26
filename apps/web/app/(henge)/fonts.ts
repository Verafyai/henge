import { Chakra_Petch } from 'next/font/google';

/** Display face for henge.verafy.ai (spin-out spec 1.3). next/font self-hosts it at build time. */
export const chakra = Chakra_Petch({ subsets: ['latin'], weight: ['600', '700'], variable: '--font-chakra', display: 'swap' });
