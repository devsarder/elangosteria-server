const express = require("express");
require("dotenv").config();
const jwt = require("jsonwebtoken");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
// console.log(process.env.STRIPE_SECRET_KEY);

const app = express();
const cors = require("cors");
const port = process.env.PORT || 3000;
console.log("payment intent key", process.env.STRIPE_SECRET_KEY);

// middleware
app.use(express.json());
app.use(cors());
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.vdxshj0.mongodb.net/?retryWrites=true&w=majority`;
console.log("mongo db", process.env.DB_USER);
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();
    // Send a ping to confirm a successful connection
    const menuCollection = client.db("bistroDb").collection("menu");
    const cartsCollection = client.db("bistroDb").collection("carts");
    const usersCollection = client.db("bistroDb").collection("users");
    const paymentsCollection = client.db("bistroDb").collection("payments");
    // todo:verify jwt signature
    const verifyToken = (req, res, next) => {
      if (!req.headers.authorization) {
        return res.status(401).send({ message: "forbidden" });
      }
      const token = req.headers.authorization.split(" ")[1];
      jwt.verify(token, process.env.ACCESS_WEB_TOKEN, function (err, decoded) {
        if (err) {
          return res.status(403).send({ message: "forbidden" });
        }
        req.decoded = decoded;
        next();
      });
    };
    // verify is admin
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      const isAdmin = user?.role == "admin";
      if (!isAdmin) {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };
    // token related api methods
    app.post("/jwt", async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_WEB_TOKEN, {
        expiresIn: "1h",
      });
      res.send({ token: token });
    });
    // payment intent
    app.post("/create-payment-intent", async (req, res) => {
      const { price } = req.body;
      const amount = price * 100;
      if (!price || amount < 1) return;
      const parsedInt = parseInt(amount);
      console.log(parsedInt, "amount inside payment intent");
      const paymentIntent = await stripe.paymentIntents.create({
        amount: parsedInt,
        currency: "usd",
        payment_method_types: ["card"],
      });
      res.send({ clientSecret: paymentIntent.client_secret });
    });
    // payment collecting intent
    app.post("/payments", async (req, res) => {
      const payment = req.body;
      const paymentResult = await paymentsCollection.insertOne(payment);
      console.log(payment);

      // delete paid items from carts

      const query = {
        _id: {
          $in: payment.cartId.map((id) => new ObjectId(id)),
        },
      };
      const deleteResult = await cartsCollection.deleteMany(query);
      res.send({ paymentResult: paymentResult, deleteResult: deleteResult });
    });
    // admin stats
    app.get("/admin-stats", verifyToken, verifyAdmin, async (req, res) => {
      const users = await usersCollection.estimatedDocumentCount();
      const menuItems = await menuCollection.estimatedDocumentCount();
      const orders = await paymentsCollection.estimatedDocumentCount();

      const result = await paymentsCollection
        .aggregate([
          {
            $group: {
              _id: null, //to group all the elements
              totalRevenue: { $sum: "$price" },
            },
          },
        ])
        .toArray();
      const revenue = result.length > 0 ? result[0].totalRevenue : 0;
      res.send({ users, menuItems, orders, revenue });
    });
    // order-stats
    app.get("/order-stats", async (req, res) => {
      const result = await paymentsCollection
        .aggregate([
          {
            $unwind: "$menuItemIds",
          },
          {
            $lookup: {
              from: "menu",
              localField: "menuItemIds",
              foreignField: "_id",
              as: "menuItems",
            },
          },
          {
            $unwind: "$menuItems",
          },
          {
            $group: {
              _id: "$menuItems.category",
              quantity: { $sum: 1 },
              totalRevenue: { $sum: "$menuItems.price" },
            },
          },
          {
            $project: {
              _id: 0,
              category: "$_id",
              quantity: "$quantity",
              revenue: "$totalRevenue",
            },
          },
        ])
        .toArray();
      res.send(result);
    });
    // admin validation methods
    app.get("/users/admin/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        res.status(403).send({ message: "unauthorized access" });
      }
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      let admin = false;
      if (user) {
        admin = user?.role === "admin";
      }
      res.send({ admin: admin });
    });
    // save user email and name to database
    app.post("/users", async (req, res, next) => {
      const user = req.body;
      console.log(user);
      const query = user?.email;
      const existingEmail = await usersCollection.findOne({
        email: user.email,
      });
      if (existingEmail) {
        return res.send({ message: "Email already exists", insertedId: null });
      }
      const result = await usersCollection.insertOne({ email: user.email });
      res.send(result);
    });
    // get all users
    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });
    // delete single user
    app.delete("/users/:id", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      console.log("delete user id", id);
      const query = { _Id: new ObjectId(id) };
      const result = await usersCollection.deleteOne(query);
      res.send(result);
    });
    // update user based on role
    app.patch(
      "/users/admin/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            role: "admin",
          },
        };
        const result = await usersCollection.updateOne(filter, updatedDoc);
        res.send(result);
      }
    );
    // save carts details
    app.post("/carts", async (req, res) => {
      const cart = req.body;
      const result = await cartsCollection.insertOne(cart);
      res.send(result);
    });
    // get cart json data
    app.get("/carts", async (req, res) => {
      const email = req.query.email;
      const query = { email: email };
      // console.log(email);
      const result = await cartsCollection.find(query).toArray();
      res.send(result);
    });
    // delete cart items
    app.delete("/carts/:id", async (req, res) => {
      const id = req.params.id;
      // console.log(id);
      const query = { _id: new ObjectId(id) };
      const result = await cartsCollection.deleteOne(query);
      res.send(result);
    });
    // post menu items
    app.post("/menu", verifyToken, verifyAdmin, async (req, res) => {
      const item = req.body;
      const result = await menuCollection.insertOne(item);
      res.send(result);
    });
    app.get("/menu", async (req, res) => {
      const cursor = menuCollection.find();
      const result = await cursor.toArray();
      res.send(result);
    });
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!"
    // );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("hello world");
});

app.listen(port, () => {
  console.log(`listening on ${port}`);
});
