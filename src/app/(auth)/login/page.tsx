import LoginUI from "@/modules/auth/components/login-ui";
import { requireUnAuth } from "@/modules/auth/utils/auth-utils";
import { Suspense } from "react";

const LoginPage = async () => {
	await requireUnAuth()

	return (
		<div>
		 <Suspense fallback={<div>Loading...</div>}>
      <LoginUI />
    </Suspense>
		</div>
	);
};

export default LoginPage;