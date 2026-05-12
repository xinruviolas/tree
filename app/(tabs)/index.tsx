import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import * as AuthSession from 'expo-auth-session';
import { AccessTokenRequest } from 'expo-auth-session';
import * as Google from 'expo-auth-session/providers/google';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';


/** Running inside the Expo Go app — OAuth must use the HTTPS Expo auth proxy; Google rejects `exp://` on Web OAuth clients. */
function isExpoGo(): boolean {
  return Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
}

/** `https://auth.expo.io/@owner/slug` — Google accepts this as a redirect URI (https). */
function getExpoAuthProxyRedirectUri(): string | null {
  const fromEnv = process.env.EXPO_PUBLIC_EXPO_PROJECT_FULL_NAME?.trim();
  const fromConfig = Constants.expoConfig?.originalFullName?.trim();
  const fullName = fromEnv || fromConfig;
  if (!fullName) return null;
  return `https://auth.expo.io/${fullName.replace(/^\//, '')}`;
}

/** Expo Go: open the auth proxy `/start` URL; the in-app browser must complete on `exp://…` (returnUrl), not on auth.expo.io. */
function buildExpoAuthProxyStartUrl(authUrl: string, projectPathUnderAuthExpoIo: string): string {
  const returnUrl = AuthSession.getDefaultReturnUrl();
  const qs = new URLSearchParams({ authUrl, returnUrl }).toString();
  return `https://auth.expo.io/${projectPathUnderAuthExpoIo}/start?${qs}`;
}

type GoogleIds = {
  webClientId?: string;
  iosClientId?: string;
  androidClientId?: string;
};

function readGoogleIdsFromEnv(): GoogleIds {
  return {
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
    androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
  };
}

/**
 * Google "Web application" OAuth clients require client_secret when exchanging an auth code at the
 * token endpoint (even with PKCE). Expo Go uses that client type with auth.expo.io — set this in
 * .env for local dev only; do not ship a public build with a secret baked in (use a dev build +
 * iOS client, or a small backend exchange, for production).
 */
function readGoogleWebClientSecretForDev(): string | undefined {
  const s = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_SECRET?.trim();
  return s || undefined;
}

function getRequiredClientIdForPlatform(ids: GoogleIds): string | undefined {
  if (Platform.OS === 'web') return ids.webClientId;
  // Expo Go (any native platform): must use Web client ID for exp:// redirects.
  if (isExpoGo()) return ids.webClientId;
  if (Platform.OS === 'ios') return ids.iosClientId;
  if (Platform.OS === 'android') return ids.androidClientId;
  return ids.webClientId;
}

function envVarNameForSetup(): string {
  if (Platform.OS === 'web') return 'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID';
  if (isExpoGo()) return 'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID';
  if (Platform.OS === 'ios') return 'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID';
  return 'EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID';
}

function missingExpoGoProxySetup(): string | null {
  if (!isExpoGo() || Platform.OS === 'web') return null;
  if (getExpoAuthProxyRedirectUri()) return null;
  return 'EXPO_PUBLIC_EXPO_PROJECT_FULL_NAME';
}

async function fetchGoogleGivenName(accessToken: string): Promise<string> {
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Profile request failed (${res.status})`);
  }
  const data = (await res.json()) as { given_name?: string; name?: string };
  return data.given_name ?? data.name?.split(/\s+/)[0] ?? 'there';
}

function GoogleHelloScreen({ ids }: { ids: GoogleIds }) {
  const useExpoGoWebFlow = isExpoGo() && Platform.OS !== 'web';
  const expoProxyRedirectUri = useMemo(() => getExpoAuthProxyRedirectUri(), []);

  const webClientSecretDev = useMemo(() => readGoogleWebClientSecretForDev(), []);

  const googleAuthConfig = useMemo(() => {
    if (!useExpoGoWebFlow) return ids;
    if (!expoProxyRedirectUri) {
      return {
        webClientId: ids.webClientId,
        clientId: ids.webClientId,
      };
    }
    return {
      webClientId: ids.webClientId,
      clientId: ids.webClientId,
      redirectUri: expoProxyRedirectUri,
      // Web client + auth code: Google requires client_secret at token exchange; omit only if
      // using implicit token response (less reliable; Google may disable for your client).
      clientSecret: webClientSecretDev,
    };
  }, [ids, useExpoGoWebFlow, expoProxyRedirectUri, webClientSecretDev]);

  const redirectUriOptions = useMemo(() => {
    if (!useExpoGoWebFlow || expoProxyRedirectUri) return {};
    return { preferLocalhost: true };
  }, [useExpoGoWebFlow, expoProxyRedirectUri]);

  const [request, response, promptAsync] = Google.useAuthRequest(googleAuthConfig, redirectUriOptions);
  const [givenName, setGivenName] = useState<string | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [expoGoAccessToken, setExpoGoAccessToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accessToken = useMemo(() => {
    if (expoGoAccessToken) return expoGoAccessToken;
    if (response?.type === 'success' && response.authentication?.accessToken) {
      return response.authentication.accessToken;
    }
    return null;
  }, [expoGoAccessToken, response]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!accessToken) {
        return;
      }
      setLoadingProfile(true);
      setError(null);
      try {
        const name = await fetchGoogleGivenName(accessToken);
        if (!cancelled) setGivenName(name);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not load profile');
        }
      } finally {
        if (!cancelled) setLoadingProfile(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const signOut = useCallback(() => {
    setGivenName(null);
    setExpoGoAccessToken(null);
    setError(null);
  }, []);

  const onSignIn = useCallback(async () => {
    setError(null);

    const useProxyStart =
      useExpoGoWebFlow && expoProxyRedirectUri && request?.url && ids.webClientId;

    if (useProxyStart) {
      setSigningIn(true);
      try {
        const projectPath = expoProxyRedirectUri.replace(/^https:\/\/auth\.expo\.io\//, '');
        const returnUrl = AuthSession.getDefaultReturnUrl();
        const startUrl = buildExpoAuthProxyStartUrl(request.url, projectPath);
        const browserResult = await WebBrowser.openAuthSessionAsync(startUrl, returnUrl, {
          preferEphemeralSession: true,
        });

        if (browserResult.type !== 'success' || !('url' in browserResult) || !browserResult.url) {
          if (browserResult.type !== 'cancel' && browserResult.type !== 'dismiss') {
            setError('Sign-in was not completed');
          }
          return;
        }

        const parsed = request.parseReturnUrl(browserResult.url);
        if (parsed.type === 'error') {
          const err = parsed.error;
          setError(
            err ? [err.error, err.description].filter(Boolean).join(': ') || 'OAuth error' : 'OAuth error',
          );
          return;
        }

        let token = parsed.authentication?.accessToken ?? null;
        if (!token && parsed.params.code) {
          const exchange = new AccessTokenRequest({
            clientId: ids.webClientId,
            redirectUri: expoProxyRedirectUri,
            code: parsed.params.code,
            extraParams: {
              code_verifier: request.codeVerifier ?? '',
            },
          });
          const authResponse = await exchange.performAsync(Google.discovery);
          token = authResponse.accessToken;
        }

        if (!token) {
          setError('No access token from Google');
          return;
        }
        setExpoGoAccessToken(token);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Sign-in failed');
      } finally {
        setSigningIn(false);
      }
      return;
    }

    void promptAsync({ preferEphemeralSession: true });
  }, [
    expoProxyRedirectUri,
    ids.webClientId,
    promptAsync,
    request,
    useExpoGoWebFlow,
  ]);

  if (givenName) {
    return (
      <ThemedView style={styles.centered}>
        <ThemedText type="title" style={styles.greeting}>
          hello
        </ThemedText>
        <ThemedText type="subtitle" style={styles.firstName}>
          {givenName}
        </ThemedText>
        <Pressable style={styles.buttonSecondary} onPress={signOut}>
          <ThemedText type="defaultSemiBold">Sign out</ThemedText>
        </Pressable>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.centered}>
      <ThemedText type="title" style={styles.title}>
        Hello world
      </ThemedText>
      <ThemedText style={styles.subtitle}>
        Sign in with Google to see your first name. Apple or Google may show a sign-in security
        prompt first; apps cannot turn that off.
      </ThemedText>
      {error ? (
        <ThemedText style={styles.error} accessibilityRole="alert">
          {error}
        </ThemedText>
      ) : null}
      {loadingProfile || signingIn ? (
        <View style={styles.loader}>
          <ActivityIndicator />
          <ThemedText style={styles.loaderLabel}>
            {signingIn ? 'Opening Google…' : 'Loading your profile…'}
          </ThemedText>
        </View>
      ) : (
        <Pressable
          style={[styles.button, (!request || signingIn) && styles.buttonDisabled]}
          onPress={onSignIn}
          disabled={!request || signingIn}>
          <ThemedText type="defaultSemiBold" style={styles.buttonLabel}>
            Continue with Google
          </ThemedText>
        </Pressable>
      )}
    </ThemedView>
  );
}

export default function HomeScreen() {
  const ids = useMemo(() => readGoogleIdsFromEnv(), []);
  const requiredId = getRequiredClientIdForPlatform(ids);
  const missingProxy = missingExpoGoProxySetup();

  if (!requiredId) {
    const key = envVarNameForSetup();

    return (
      <ThemedView style={styles.centered}>
        <ThemedText type="title" style={styles.title}>
          Setup needed
        </ThemedText>
        <ThemedText style={styles.subtitle}>
          Add <ThemedText type="defaultSemiBold">{key}</ThemedText> to your{' '}
          <ThemedText type="defaultSemiBold">.env</ThemedText> (see{' '}
          <ThemedText type="defaultSemiBold">.env.example</ThemedText>), then restart Expo.
          {isExpoGo() ? (
            <>
              {' '}
              In Expo Go, Google uses your <ThemedText type="defaultSemiBold">Web</ThemedText> OAuth
              client. Add redirect{' '}
              <ThemedText type="defaultSemiBold">https://auth.expo.io/@YOUR_EXPO_USERNAME/tree</ThemedText>{' '}
              and copy the Web client&apos;s <ThemedText type="defaultSemiBold">Client secret</ThemedText>{' '}
              into <ThemedText type="defaultSemiBold">EXPO_PUBLIC_GOOGLE_WEB_CLIENT_SECRET</ThemedText>{' '}
              (local dev only — see <ThemedText type="defaultSemiBold">.env.example</ThemedText>). Set{' '}
              <ThemedText type="defaultSemiBold">EXPO_PUBLIC_EXPO_PROJECT_FULL_NAME</ThemedText> if needed.
            </>
          ) : (
            <>
              {' '}
              Create OAuth client IDs in Google Cloud Console and use the redirect URIs required
              for your build type.
            </>
          )}
        </ThemedText>
      </ThemedView>
    );
  }

  if (missingProxy) {
    const example = `https://auth.expo.io/@your-expo-username/${Constants.expoConfig?.slug ?? 'tree'}`;
    return (
      <ThemedView style={styles.centered}>
        <ThemedText type="title" style={styles.title}>
          Expo Go: project name
        </ThemedText>
        <ThemedText style={styles.subtitle}>
          Add <ThemedText type="defaultSemiBold">{missingProxy}=@your-expo-username/tree</ThemedText>{' '}
          to your <ThemedText type="defaultSemiBold">.env</ThemedText> (same as in the Expo dashboard
          URL). In Google Cloud, add redirect URI{' '}
          <ThemedText type="defaultSemiBold">{example}</ThemedText> with your real username. Run{' '}
          <ThemedText type="defaultSemiBold">npx expo whoami</ThemedText> if you are unsure of your
          Expo account name.
        </ThemedText>
      </ThemedView>
    );
  }

  return <GoogleHelloScreen ids={ids} />;
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    gap: 16,
  },
  title: {
    textAlign: 'center',
  },
  greeting: {
    textAlign: 'center',
  },
  firstName: {
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 8,
  },
  subtitle: {
    textAlign: 'center',
    opacity: 0.85,
    maxWidth: 360,
  },
  error: {
    color: '#c00',
    textAlign: 'center',
    maxWidth: 360,
  },
  loader: {
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  loaderLabel: {
    opacity: 0.8,
  },
  button: {
    backgroundColor: '#4285F4',
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 8,
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonSecondary: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    marginTop: 4,
  },
  buttonLabel: {
    color: '#fff',
  },
});
