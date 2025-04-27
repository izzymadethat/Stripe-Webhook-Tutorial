require("dotenv").config();
const express = require("express");
const { prisma } = require("./lib/prisma");
const app = express();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

app.set("view engine", "ejs");

app.get("/", async (req, res) => {
	res.render("index.ejs");
});

app.get("/subscribe", async (req, res) => {
	const plan = req.query.plan;

	if (!plan) {
		return res.status(400).send("Subscription plan not found");
	}

	let priceId;

	switch (plan.toLowerCase()) {
		case "starter":
			priceId = process.env.STRIPE_STARTER_PRICE_ID;
			break;
		case "pro":
			priceId = process.env.STRIPE_PRO_PRICE_ID;
			break;
		default:
			return res.status(400).send("Invalid subscription plan");
	}

	const session = await stripe.checkout.sessions.create({
		mode: "subscription",
		line_items: [
			{
				price: priceId,
				quantity: 1,
			},
		],
		success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
		cancel_url: `${process.env.BASE_URL}/cancel`,
	});

	res.redirect(session.url);
});

app.get("/success", async (req, res) => {
	// const session = await stripe.checkout.sessions.retrieve(
	//   req.query.session_id,
	//   { expand: ["subscription", "subscription.plan.product"] }
	// );

	res.send("Subscription successful");
});

app.get("/customers/:customerId", async (req, res) => {
	const portalSession = await stripe.billingPortal.sessions.create({
		customer: req.params.customerId,
		return_url: `${process.env.BASE_URL}/`,
	});

	res.redirect(portalSession.url);
});

app.post(
	"/webhook",
	express.raw({ type: "application/json" }),
	async (req, res) => {
		const sig = req.headers["stripe-signature"];

		let event;

		try {
			event = stripe.webhooks.constructEvent(
				req.body,
				sig,
				process.env.STRIPE_WEBHOOK_SECRET_KEY,
			);
		} catch (err) {
			res.status(400).send(`Webhook Error: ${err.message}`);
			return;
		}

		// Handle the event
		switch (event.type) {
			// Event when subscription started
			case "checkout.session.completed": {
				const session = event?.data.object;
				if (session.payment_status === "paid") {
					console.log("New subscription started!");
					const newUser = await prisma.user.create({
						data: {
							email: session.customer_details.email,
							name: session.customer_details.name,
						},
					});

					if (session.subscription) {
						await prisma.subscription.upsert({
							where: {
								stripeSubId: session.subscription,
							},
							update: {},
							create: {
								amount: session.amount_total,
								userId: newUser.id,
							},
						});
					}
				}

				break;
			}

			// Event when payment is successful every interval
			case "invoice.paid":
				console.log("Subscription payment successful!");
				{
					const session = event.data.object;
					console.log("SUB LINES", session.lines.data);
					await prisma.subscription.create({
						data: {
							amount: session.amount_paid,
							stripeSubId: session.subscription,
							userId: "cm9zak1fw0000ctzggu9j82a4",
							cancelAtPeriodEnd: false,
						},
					});
					break;
				}

			// Event when payment failed every interval
			case "invoice.payment_failed":
				console.log("Subscription payment failed!");
				break;
			// Event when subscription is updated (deleted or upgraded)
			case "customer.subscription.updated":
				console.log("Subscription updated!");
				console.log(event.data);
				break;
			default:
				console.log(`Unhandled event type ${event.type}`);
		}

		res.send();
	},
);

app.get("/cancel", (req, res) => {
	res.redirect("/");
});

app.listen(3005, () => console.log("Server started on port 3005"));
